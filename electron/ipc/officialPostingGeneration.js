import crypto from 'node:crypto';
import { handleSafe } from './ipcUtils.js';
import { officialPostingAliases, officialPostingRecordMatchesScrapedIdentity } from './officialPostingStore.js';
import { getOfficialPostingStore, mergeOfficialPostingTelemetry, resolveOfficialPostings } from './officialPostingService.js';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { unresolvedOfficialPosting } from './officialPostingResolver.js';
import { normalizeAlternateListings, normalizeBoardClosed, normalizeListingLiveness, normalizeOfficialPosting, officialHttpsUrl, officialPostingAfterRepeatAttempt, officialPostingLookupStatus, officialPostingCitedLeadUrls } from './officialPostingFields.js';
import { checkListingForGeneration, checkPostingVariantsForGeneration, decideGenerationListingCheck, normalizeListingAudit, recordGenerationFallbackHold } from './listingLivenessProbe.js';
import { normaliseJobPostingVariants } from './applicationBundle.js';
import { callLLMText } from './llm.js';
import { officialPostingSemanticInputHash, officialPostingSemanticProofMatches } from './officialPostingSemantic.js';
import { registerOfficialPostingRefreshHandler } from './officialPostingRefresh.js';

const OFFICIAL_POSTING_PREPARE_TIMEOUT_MS = 15 * 60 * 1000;
const PREPARED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PREPARED_RECORDS = 128;
const MAX_PREPARED_BYTES = 32 * 1024 * 1024;
const STORE_DRAIN_TIMEOUT_MS = 2_000;
const prepared = new Map();
const officialLevels = new Set(['L1', 'L2', 'L3', 'L4']);
const textLevels = new Set(['L1', 'L2', 'L3']);
const aliasesOf = job => officialPostingAliases(job).sort();
function errorWithCode(code) { return Object.assign(new Error(code), { code }); }
function active(signal) { if (signal?.aborted) throw signal.reason || errorWithCode('worker-aborted'); }

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
        reject(signal.reason || errorWithCode('worker-aborted'));
      } };
      signal?.addEventListener('abort', waiter.abort, { once: true }); waiting.push(waiter); drain();
    });
  } };
}
const semaphore = createOfficialPostingPrepareSemaphore();

const preparedByteSizes = new WeakMap();
function preparedBytes(record) {
  if (!preparedByteSizes.has(record)) preparedByteSizes.set(record, Buffer.byteLength(JSON.stringify(record)));
  return preparedByteSizes.get(record);
}

function remember(scrapedJob, result, now) {
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
    boardClosed: normalizeBoardClosed(result.boardClosed), aliases, createdAt: now, semanticMatching: true,
    freshness: 'fresh-discovery', inputHash: officialPostingSemanticInputHash(scrapedJob) };
  const resolutionId = crypto.randomUUID();
  prepared.set(resolutionId, record);
  let bytes = [...prepared.values()].reduce((sum, value) => sum + preparedBytes(value), 0);
  while (prepared.size > MAX_PREPARED_RECORDS || bytes > MAX_PREPARED_BYTES) {
    const first = prepared.keys().next().value; bytes -= preparedBytes(prepared.get(first)); prepared.delete(first);
  }
  return { resolutionId: prepared.has(resolutionId) ? resolutionId : undefined,
    preparedAt: new Date(record.createdAt).toISOString(),
    officialPosting: record.officialPosting, postedBy: record.postedBy,
    listingCheck: result.listingCheck, listingLiveness: record.listingLiveness,
    boardClosed: record.boardClosed, listingLinkUrl: record.listingLinkUrl,
    postingVariants: record.postingVariants,
    message: String(result.message || '').slice(0, 160) };
}

async function checkAlternateLinks({ job, posting, primary, probe, callText,
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
        callText, calibrationStore, signal, now, deadline,
        manualAiRunId, nodeId, listingOverride: false });
      active(signal);
    } catch (error) {
      if (signal?.aborted && signal.reason?.code !== 'worker-timeout') throw signal.reason || error;
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
  try { if (record.inputHash !== officialPostingSemanticInputHash(scrapedJob)) return null; }
  catch { return null; }
  if (officialLevels.has(record.officialPosting.level) && !officialPostingSemanticProofMatches(scrapedJob, record.officialPosting)) return null;
  return structuredClone(record);
}

/** Whole-budget prepare includes the semaphore wait. Every non-cancellation
 * failure produces a bounded host fallback for the normal application gate. */
export async function prepareOfficialPostingForGeneration(args, {
  projectJob = value => value, signal, store, fetch = fetchOfficialPosting, resolve = resolveOfficialPostings,
  now = Date.now, timeoutMs = OFFICIAL_POSTING_PREPARE_TIMEOUT_MS,
  slots = semaphore, callRaw, callMatch, callText = callLLMText, telemetry = { failed: 0 }, listingProbe, calibrationStore,
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
    if (!['incomplete', 'unchecked'].includes(lookup.state)
      || listing.listingCheck?.action === 'refuse-final') return listing;
    return { ...listing, listingCheck: { ...listing.listingCheck,
      action: 'refuse-retry', basis: 'official-lookup', override: false },
    message: `${lookup.label}. Retry Generate to finish checking the official posting.`,
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
  const controller = new AbortController(); const abort = () => controller.abort(signal.reason || errorWithCode('worker-aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(errorWithCode('worker-timeout')), timeoutMs); timer.unref?.();
  let onAbort; const cancelled = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  };
  let release; let finalPosting; let resolvedTelemetry = null;
  try {
    finalPosting = await Promise.race([(async () => {
      active(controller.signal); release = await slots.acquire(controller.signal); active(controller.signal);
      store = trackedStore(store || getOfficialPostingStore());
      const record = await store.find(scrapedJob); active(controller.signal);
      const resolveFresh = async ({ candidateUrls = [], bypassCache = false, priorOfficialRecord } = {}) => {
        const resolved = await resolve([scrapedJob], { store, snapshotFetch: fetch, signal: controller.signal,
          manualAiRunId: args.manualAiRunId, nodeId: args.nodeId, callRaw, callMatch, now,
          timeoutMs, candidateUrls, bypassCache,
          ...(priorOfficialRecord ? { priorOfficialRecords: [priorOfficialRecord] } : {}) });
        resolvedTelemetry = mergeOfficialPostingTelemetry(resolvedTelemetry, resolved.telemetry);
        active(controller.signal);
        const posting = normalizeOfficialPosting(resolved.jobs[0]?.officialPosting);
        if (!posting || officialLevels.has(posting.level) && (!officialPostingSemanticProofMatches(scrapedJob, posting)
          || !/^[a-f0-9]{64}$/u.test(posting.semanticMatch?.sourceHash))) {
          return unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: ['comparative-invalid'] });
        }
        return { officialPosting: posting, postedBy: resolved.jobs[0].postedBy, resolvedFresh: true,
          description: textLevels.has(posting.level) && posting.contentHash ? await store.readText(posting.contentHash) : undefined };
      };
      const boundRecord = record && officialPostingRecordMatchesScrapedIdentity(scrapedJob, record) ? record : null;
      const cachedPosting = normalizeOfficialPosting(boundRecord?.officialPosting);
      const candidateUrls = [...new Set([cachedPosting?.sourceUrl, cachedPosting?.officialApplyUrl,
        cardPosting?.sourceUrl, cardPosting?.officialApplyUrl, ...officialPostingCitedLeadUrls(cardPosting)].map(officialHttpsUrl).filter(Boolean))];
      // Every generation uses the current shared discovery and comparison
      // process. Old URLs are leads; neither cached facts nor a weak fresh
      // recheck may authorize this application's official posting.
      return resolveFresh({ candidateUrls, bypassCache: true, priorOfficialRecord: boundRecord });
    })(), cancelled]);
  } catch (error) {
    if (signal?.aborted) { cleanup(); throw signal.reason || error; }
    failed(error);
    const code = controller.signal.reason?.code === 'worker-timeout' ? 'worker-timeout' : error?.code || 'failed';
    finalPosting = unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: [code] });
  } finally {
    // Cancellation must finish owned filesystem work before cancel-and-wait
    // releases this preparation. Research may ignore its signal, so only the
    // bounded host-store operations participate in this short drain.
    if (controller.signal.aborted) await drainStoreOperations();
    release?.();
  }
  try {
    // Generate is an attempt too: the same doubt twice no longer holds the application back.
    finalPosting = { ...finalPosting, officialPosting: officialPostingAfterRepeatAttempt(cardPosting, finalPosting.officialPosting) };
    let listing;
    if (controller.signal.aborted && !signal?.aborted) {
      listing = await typedFallback(scrapedJob, finalPosting.officialPosting);
    } else {
      try {
        listing = await checkListingForGeneration({
          job: scrapedJob, posting: finalPosting.officialPosting, probe: listingProbe,
          callText, calibrationStore, signal: controller.signal,
          deadline, now, manualAiRunId: args.manualAiRunId, nodeId: args.nodeId,
          listingOverride: args.listingOverride === true,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        listing = controller.signal.reason?.code === 'worker-timeout' || error?.code === 'worker-timeout'
          ? await typedFallback(scrapedJob, finalPosting.officialPosting)
          : holdFallback(scrapedJob, finalPosting.officialPosting);
      }
    }
    listing = await checkAlternateLinks({ job: scrapedJob,
      posting: finalPosting.officialPosting, primary: listing, probe: listingProbe,
      callText, calibrationStore, signal: controller.signal, now, deadline,
      manualAiRunId: args.manualAiRunId, nodeId: args.nodeId });
    listing = guardOfficialLookup(finalPosting.officialPosting, listing);
    let postingVariants = normaliseJobPostingVariants(scrapedJob.postingVariants);
    if (!controller.signal.aborted && postingVariants.length) try {
      postingVariants = await checkPostingVariantsForGeneration({ job: scrapedJob,
        variants: postingVariants, probe: listingProbe, callText,
        calibrationStore, signal: controller.signal, now, deadline,
        manualAiRunId: args.manualAiRunId, nodeId: args.nodeId });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      // Variant availability cannot change the primary listing decision.
    }
    if (signal?.aborted) throw signal.reason || errorWithCode('worker-aborted');
    return { ...remember(scrapedJob, { ...finalPosting, ...listing, postingVariants }, now()),
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
  registerOfficialPostingRefreshHandler({ ...dependencies, projectJob });
}
