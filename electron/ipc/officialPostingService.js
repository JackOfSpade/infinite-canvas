import path from 'node:path';
import crypto from 'node:crypto';
import electronPkg from 'electron';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';
import { callLLMRaw } from './llm.js';
import { createOfficialPostingStore, officialPostingView, officialPostingRecordMatchesScrapedIdentity, officialPostingAliases } from './officialPostingStore.js';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { createOfficialPostingFetchSession } from './officialPostingFetchSession.js';
import { extractOfficialPostingCandidates } from './officialPostingExtractors.js';
import { officialPostingChunks, resolveOfficialPosting, unresolvedOfficialPosting, createOfficialPostingRowBudget, shouldPersistOfficialPostingResult } from './officialPostingResolver.js';
import { descriptionOverlap } from './officialPostingMatch.js';
import { officialPostingSemanticInputHash, officialPostingSemanticProofMatches } from './officialPostingSemantic.js';
import { extractAtsTenant, strictEmployerEqual } from './officialSourceHosts.js';
import { normalizeOfficialPosting, officialHttpsUrl, boundedOfficialPostingTrail, OFFICIAL_POSTING_LEVELS, OFFICIAL_POSTING_OUTCOMES, OFFICIAL_POSTING_TRAIL, OFFICIAL_POSTING_COMPARATIVE_CODES } from './officialPostingFields.js';
import { mergeListingLivenessTelemetry } from './listingLivenessTelemetry.js';
import { mergeBoardClosedTelemetry } from './officialPostingBoardClosed.js';
import { buildOfficialPostingResearchRequest, parseOfficialPostingResearchResponse, buildOfficialPostingMatchRequest, validateOfficialPostingMatchResponse,
  buildSemanticOfficialPostingMatchRequest, validateSemanticOfficialPostingMatchResponse,
  buildSemanticOfficialPostingShortlistRequest, validateSemanticOfficialPostingShortlistResponse } from './officialPostingBridge.js';
import { hasLiveObservedWorker, hasPendingObservedWorkerLaunch } from './handoffBridge/observedChatContext.js';
import { CONSTANTS } from './handoffBridge/constants.js';

export const OFFICIAL_POSTING_HANDOFF_TIMEOUT_MS = 20 * 60 * 1_000;
export const OFFICIAL_POSTING_COMPARATIVE_WORKER_GRACE_MS = 15_000;
const VERIFIED_LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const TEXT_LEVELS = new Set(['L1', 'L2', 'L3']);
const stores = new Map();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizedText = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();

/** The same host-owned store serves search, scoring, compensation and Generate. */
export function getOfficialPostingStore() {
  const root = path.join(electronPkg.app.getPath('userData'), 'official-postings');
  if (!stores.has(root)) stores.set(root, createOfficialPostingStore(root));
  return stores.get(root);
}

/** Missing text is fetched through the bounded host fetcher; the store accepts
 * only bytes reproducing the already verified record's content hash. */
export async function getOfficialPostingView(job, { store, fetch = fetchOfficialPosting, signal, refetch, requireSemantic = true } = {}) {
  if (!normalizeOfficialPosting(job?.officialPosting)) return officialPostingView(job);
  try { store ||= getOfficialPostingStore(); } catch { return officialPostingView(job); }
  const restore = refetch || (async (url, { contentHash }) => {
    const page = await fetch(url, { signal });
    const sourceUrl = page.url || page.sourceUrl || url;
    const route = extractAtsTenant(sourceUrl, { html: page.body });
    const candidates = extractOfficialPostingCandidates({ body: page.body, sourceUrl, contentType: page.contentType,
      ats: route?.ats || '', tenant: route?.tenant || '' });
    return candidates.find(candidate => hash(candidate.description || '') === contentHash)?.description;
  });
  return officialPostingView(job, { store, refetch: restore, requireSemantic });
}

function bridgeError(code) { const error = new Error(code); error.code = code; return error; }
function failureCode(error, signal) {
  if (signal?.aborted && signal.reason?.code === 'bridge-timeout') return 'bridge-timeout';
  if (signal?.aborted) return 'bridge-aborted';
  if (error?.code === 'bridge-timeout') return 'bridge-timeout';
  if (error?.code === 'bridge-unavailable' || /bridge.*(?:unavailable|disabled|not linked)/iu.test(String(error?.message || ''))) return 'bridge-unavailable';
  return 'research-miss';
}

export async function cappedHandoff(request, { call, signal, timeoutMs, manualAiRunId, nodeId, hints, now, stats,
  comparativeWorkerAvailable = null, comparativeWorkerLaunching = null, comparativeGraceMs = OFFICIAL_POSTING_COMPARATIVE_WORKER_GRACE_MS }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || bridgeError('bridge-aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(bridgeError('bridge-timeout')), timeoutMs);
  timer.unref?.();
  let unavailableSince = null;
  let launchWaitingSince = null;
  const checkWorkers = () => {
    let available = false;
    try { available = comparativeWorkerAvailable() === true; } catch { /* no proof of a live worker */ }
    const stamp = now();
    if (available) { unavailableSince = null; launchWaitingSince = null; }
    else {
      let launching = false;
      try { launching = comparativeWorkerLaunching?.() === true; } catch { /* no proof of a pending launch */ }
      if (launching) launchWaitingSince ??= stamp;
      else launchWaitingSince = null;
      if (launching && stamp - launchWaitingSince < CONSTANTS.CHAT_LAUNCH_PRESENTATION_TIMEOUT_MS) {
        unavailableSince = null;
        return;
      }
      unavailableSince ??= stamp;
      if (stamp - unavailableSince >= comparativeGraceMs) controller.abort(bridgeError('comparative-unavailable'));
    }
  };
  const availabilityTimer = typeof comparativeWorkerAvailable === 'function'
    ? setInterval(checkWorkers, Math.max(1, Math.min(250, comparativeGraceMs))) : null;
  availabilityTimer?.unref?.();
  if (availabilityTimer) checkWorkers();
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason || bridgeError('bridge-aborted')); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  const start = now();
  stats.handoffs += 1;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const { prompt, ...options } = request;
    return await Promise.race([Promise.resolve().then(() => call(prompt, { ...options,
      signal: controller.signal, manualAiRunId, nodeId, hints: { ...options.hints, ...hints } })), cancelled]);
  } finally {
    clearTimeout(timer); clearInterval(availabilityTimer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort);
    const elapsed = Math.max(0, now() - start);
    stats.handoffMs += elapsed;
  }
}

function addTrail(result, code) {
  const posting = result?.officialPosting || unresolvedOfficialPosting({}).officialPosting;
  return { ...result, officialPosting: { ...posting, trail: boundedOfficialPostingTrail([...(posting.trail || []), code]) } };
}
function materiallyDifferent(left, right) {
  const a = normalizedText(left); const b = normalizedText(right);
  if (!a || !b || a === b) return false;
  const words = value => value.split(/\s+/u).length;
  return descriptionOverlap(a, b).score < 0.9 || Math.abs(words(a) - words(b)) / Math.max(words(a), words(b)) > 0.15;
}
const REJECTION_CODES = Object.freeze(['title-mismatch', 'location-mismatch', 'employer-mismatch', 'tenant-unproven', 'poster-tenant', 'salary-mismatch', 'no-anchor', 'invalid-quotes', 'ambiguous', 'closed', 'unreadable', 'oversize', 'unsafe-url', 'unsafe-address', 'fetch-timeout', 'fetch-failed', 'unsupported-content-type', 'invalid-text', 'crawl-budget', 'crawl-partial', 'semantic-uncertain', 'semantic-overflow', ...OFFICIAL_POSTING_COMPARATIVE_CODES]);
const FETCH_COUNTERS = Object.freeze(['fetches', 'uniqueUrls', 'cacheHits', 'breakerTrips']);
const MISS_TTL_MS = 24 * 60 * 60 * 1_000;
const ROW_CONCURRENCY = 6;
function telemetryBlock() {
  return { total: 0, levels: Object.fromEntries(OFFICIAL_POSTING_LEVELS.map(level => [level, 0])),
    outcomes: Object.fromEntries(OFFICIAL_POSTING_OUTCOMES.map(outcome => [outcome, 0])), rejections: {},
    handoffs: 0, handoffMs: 0, failed: 0, materialJdChange: 0, bridgeTimeout: 0, bridgeUnavailable: 0,
    comparisons: 0, comparisonOptions: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, 0])),
    comparativeAgreements: 0, comparativeDisagreements: 0, comparativeInvalidRuns: 0,
    comparativeNone: 0, comparativeUnavailable: 0, comparativeMatches: 0,
    fetches: 0, uniqueUrls: 0, cacheHits: 0, maxPerHostRate: 0, breakerTrips: 0 };
}
function countPosting(stats, posting, comparison = null) {
  stats.total += 1;
  stats.levels[posting.level] += 1; stats.outcomes[posting.outcome] += 1;
  for (const code of new Set(posting.trail || [])) {
    if (code === 'bridge-timeout') stats.bridgeTimeout += 1;
    if (code === 'bridge-unavailable') stats.bridgeUnavailable += 1;
    if (code !== 'comparative-match' && REJECTION_CODES.includes(code)) stats.rejections[code] = (stats.rejections[code] || 0) + 1;
  }
  if (['found', 'link-only'].includes(posting.outcome) && posting.trail?.includes('comparative-match')) stats.comparativeMatches += 1;
  if (Number.isSafeInteger(comparison?.optionCount) && comparison.optionCount >= 1 && comparison.optionCount <= 8) {
    stats.comparisons += 1; stats.comparisonOptions[comparison.optionCount] += 1;
    if (comparison.agreement === true) stats.comparativeAgreements += 1;
    if (comparison.disagreement === true) stats.comparativeDisagreements += 1;
    if (comparison.none === true) stats.comparativeNone += 1;
    if (comparison.unavailable === true) stats.comparativeUnavailable += 1;
    if (Number.isSafeInteger(comparison.invalidRuns)) stats.comparativeInvalidRuns += Math.max(0, Math.min(2, comparison.invalidRuns));
  }
}
const count = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

/** Combine disjoint carried/resolved row counts without retaining page facts. */
export function mergeOfficialPostingTelemetry(...blocks) {
  const result = telemetryBlock();
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    for (const key of Object.keys(result)) {
      if (typeof result[key] === 'number') result[key] = key === 'maxPerHostRate'
        ? Math.max(result[key], count(block[key])) : result[key] + count(block[key]);
    }
    for (const level of OFFICIAL_POSTING_LEVELS) result.levels[level] += count(block.levels?.[level]);
    for (const outcome of OFFICIAL_POSTING_OUTCOMES) result.outcomes[outcome] += count(block.outcomes?.[outcome]);
    for (const option of Object.keys(result.comparisonOptions)) {
      const value = block.comparisonOptions?.[option];
      if (Number.isSafeInteger(value) && value >= 0) result.comparisonOptions[option] += value;
    }
    for (const code of REJECTION_CODES) if (code !== 'comparative-match' && count(block.rejections?.[code])) result.rejections[code] = (result.rejections[code] || 0) + count(block.rejections[code]);
  }
  // Per-board counts of rows an aggregator board reported closed. Present only
  // when a pass saw any, so a pass without them keeps its historical shape.
  const boardClosed = mergeBoardClosedTelemetry(...blocks.map(block => block?.boardClosed));
  if (Object.keys(boardClosed).length) result.boardClosed = boardClosed;
  const listingLiveness = mergeListingLivenessTelemetry(...blocks.map(block => block?.listingLiveness));
  if (Object.keys(listingLiveness).length) result.listingLiveness = listingLiveness;
  return result;
}
async function parallelRows(members, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ROW_CONCURRENCY, members.length) }, async () => {
    while (next < members.length) {
      const member = members[next++];
      await operation(member);
    }
  }));
}
function abortTrail(signal) {
  return OFFICIAL_POSTING_TRAIL.includes(signal?.reason?.code) ? signal.reason.code : 'bridge-aborted';
}

/** Only host records bound to this scraped identity can settle an inline row.
 * Unresolved indices preserve input order for the caller's exact merge. */
export async function partitionOfficialPostingRows(jobs, { store, signal, now = Date.now, semanticMatching = true } = {}) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const carried = rows.slice(); const settled = new Set(); const settledTelemetry = telemetryBlock();
  const instant = typeof now === 'function' ? Number(now()) : Number(now);
  try { store ||= getOfficialPostingStore(); } catch { store = null; }
  await parallelRows(rows.map((job, index) => ({ job, index })), async ({ job, index }) => {
    if (signal?.aborted || !store || !normalizeOfficialPosting(job?.officialPosting)) return;
    let record;
    try { record = await store.find(job); } catch { return; }
    const posting = normalizeOfficialPosting(record?.officialPosting);
    if (!posting || !officialPostingRecordMatchesScrapedIdentity(job, record)
      || (semanticMatching && !officialPostingSemanticProofMatches(job, posting))
      || !shouldPersistOfficialPostingResult(posting, { signal })) return;
    // Older closed-trail misses lack a candidate confirmation receipt. Revisit
    // them rather than treating an expired validThrough as a proved closure.
    if (['L5', 'L6'].includes(posting.level) && posting.trail?.includes('closed')) return;
    if (!VERIFIED_LEVELS.has(posting.level)) {
      const age = instant - record.savedAt;
      if (!Number.isFinite(age) || age < 0 || age >= MISS_TTL_MS) return;
    }
    if (signal?.aborted) return;
    const postedBy = VERIFIED_LEVELS.has(posting.level)
      ? strictEmployerEqual(posting.employer, job?.company) ? undefined : job?.company
      : unresolvedOfficialPosting(job).postedBy;
    carried[index] = { ...job, postedBy, officialPosting: posting };
    settled.add(index); countPosting(settledTelemetry, posting);
  });
  return { jobs: carried, unresolvedIndices: rows.flatMap((_, index) => settled.has(index) ? [] : [index]), settledTelemetry };
}

/** One generic Solve handler can checkpoint and publish the same inputs.
 * This receipt is local to that pass, never a durable transient-miss cache. */
export function createOfficialPostingRecoveryPassResolver(resolveRows, { signal } = {}) {
  if (typeof resolveRows !== 'function') throw new TypeError('Recovery resolution needs a host resolver.');
  const receipts = new Map(); const drops = []; const boardClosedDrops = [];
  const inputHash = job => {
    try { return officialPostingSemanticInputHash(job); } catch { return null; }
  };
  let passTelemetry = telemetryBlock();
  return async rows => {
    if (signal?.aborted) throw signal.reason || bridgeError('bridge-aborted');
    const input = Array.isArray(rows) ? rows : [];
    const consumed = new Set();
    const planned = input.map(job => {
      const currentHash = inputHash(job);
      const receipt = (receipts.get(sourceJobKey(job)) || []).find(value => !consumed.has(value)
        && currentHash && value.inputHash === currentHash
        && officialPostingRecordMatchesScrapedIdentity(job, value));
      if (receipt) consumed.add(receipt);
      return { job, receipt };
    });
    const fresh = planned.filter(item => !item.receipt);
    // Snapshot authorization before a provider or cleanup can mutate a row.
    const identities = fresh.map(({ job }) => ({ key: sourceJobKey(job), aliases: officialPostingAliases(job), inputHash: inputHash(job) }));
    if (fresh.length) {
      const resolved = await resolveRows(fresh.map(item => item.job));
      if (signal?.aborted) throw signal.reason || bridgeError('bridge-aborted');
      if (!Array.isArray(resolved?.jobs)) throw new TypeError('Recovery resolution returned invalid rows.');
      const resolvedDrops = Array.isArray(resolved.officialDedupDrops) ? resolved.officialDedupDrops : [];
      if ((Number(resolved.officialDedupDropped) || 0) !== resolvedDrops.length) throw new TypeError('Recovery resolution needs every dedup receipt.');
      // Board-closed rows the official source did not keep leave the pass the same
      // way a dedup loser does: each input identity is either kept or receipted.
      const resolvedBoardDrops = Array.isArray(resolved.boardClosedDrops) ? resolved.boardClosedDrops : [];
      if ((Number(resolved.boardClosedDropped) || 0) !== resolvedBoardDrops.length) throw new TypeError('Recovery resolution needs every board-closed receipt.');
      const accountedDrops = [...resolvedDrops, ...resolvedBoardDrops];
      const usedKept = new Set(); const usedDrops = new Set();
      for (const [index, item] of fresh.entries()) {
        const identity = identities[index];
        const sameInput = candidate => sourceJobKey(candidate) === identity.key
          && officialPostingRecordMatchesScrapedIdentity(candidate, identity);
        const keptIndex = resolved.jobs.findIndex((value, at) => !usedKept.has(at) && sameInput(value));
        const droppedIndex = keptIndex < 0 ? accountedDrops.findIndex((value, at) => !usedDrops.has(at) && sameInput(value.dropped)) : -1;
        if (keptIndex < 0 && droppedIndex < 0) throw new TypeError('Recovery resolution omitted an input identity.');
        if (keptIndex >= 0) usedKept.add(keptIndex); else usedDrops.add(droppedIndex);
        const kept = resolved.jobs[keptIndex];
        const bucket = receipts.get(identity.key) || [];
        item.receipt = { aliases: identity.aliases, inputHash: identity.inputHash, dropped: !kept,
          postedBy: kept?.postedBy, officialPosting: normalizeOfficialPosting(kept?.officialPosting) || undefined,
          boardClosed: kept?.boardClosed, listingLiveness: kept?.listingLiveness };
        bucket.push(item.receipt);
        receipts.set(identity.key, bucket);
      }
      drops.push(...resolvedDrops); boardClosedDrops.push(...resolvedBoardDrops);
      passTelemetry = mergeOfficialPostingTelemetry(passTelemetry, resolved.officialPosting);
    }
    const outputReceipts = new Map();
    const combined = planned.flatMap(({ job, receipt }) => {
      if (receipt.dropped) return [];
      const row = { ...job, postedBy: receipt.postedBy, officialPosting: receipt.officialPosting };
      if (receipt.boardClosed === undefined) delete row.boardClosed;
      else row.boardClosed = receipt.boardClosed;
      if (receipt.listingLiveness === undefined) delete row.listingLiveness;
      else row.listingLiveness = receipt.listingLiveness;
      outputReceipts.set(row, receipt);
      return [row];
    });
    const deduped = officialPostingDedup(combined);
    for (const drop of deduped.dropped) {
      const receipt = outputReceipts.get(drop.dropped);
      if (receipt) receipt.dropped = true;
    }
    drops.push(...deduped.dropped);
    return { jobs: deduped.kept, officialPosting: passTelemetry,
      officialDedupDropped: drops.length, officialDedupDrops: [...drops],
      boardClosedDropped: boardClosedDrops.length, boardClosedDrops: [...boardClosedDrops] };
  };
}

/** Chunks are frozen from this input before cache reads. Six host workers do
 * not change research membership; handoff chunks remain strictly sequential. */
export async function resolveOfficialPostings(jobs, {
  manualAiRunId, nodeId, signal, callRaw = callLLMRaw, callMatch = callRaw, onProgress, telemetry,
  store, fetch = fetchOfficialPosting, fetchSession, resolve = resolveOfficialPosting, now = Date.now,
  semanticMatching = resolve === resolveOfficialPosting, bypassCache = false, candidateUrls = [],
  timeoutMs = OFFICIAL_POSTING_HANDOFF_TIMEOUT_MS, bridgeAvailable = true,
  comparativeWorkerAvailable = callMatch === callLLMRaw ? hasLiveObservedWorker : null,
  comparativeWorkerLaunching = callMatch === callLLMRaw ? hasPendingObservedWorkerLaunch : null,
  comparativeGraceMs = OFFICIAL_POSTING_COMPARATIVE_WORKER_GRACE_MS,
} = {}) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const chunks = officialPostingChunks(rows);
  const clock = () => typeof now === 'function' ? Number(now()) : Number(now);
  const stats = telemetryBlock();
  const results = new Map(); const finished = new Set();
  const session = fetchSession || createOfficialPostingFetchSession({ fetch, signal });
  const initialFetchStats = session.telemetry();
  const members = chunks.flat();
  for (const member of members) member.rowBudget = createOfficialPostingRowBudget({ signal });
  try { store ||= getOfficialPostingStore(); } catch { store = null; }
  const progress = () => { try { onProgress?.({ completed: finished.size, total: rows.length }); } catch { /* Progress cannot fail the search. */ } };
  const settle = member => { finished.add(member); progress(); };
  const callbacksFor = (member, batch) => {
    let matchFailure = null;
    const callDecision = async (request, validate, comparative) => {
      if (matchFailure) throw matchFailure;
      if (!bridgeAvailable) throw bridgeError('bridge-unavailable');
      const attempts = callMatch === callLLMRaw ? 1 : 2;
      let correction = {};
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const raw = await cappedHandoff({ ...request, ...correction }, { call: callMatch,
            signal: semanticMatching ? signal : member.rowBudget.signal, timeoutMs, manualAiRunId, nodeId,
            hints: { itemCount: 1, batch: batch + 1, batchTotal: chunks.length }, now: clock, stats,
            ...(comparative ? { comparativeWorkerAvailable, comparativeWorkerLaunching, comparativeGraceMs } : {}) });
          return validate(raw);
        } catch (error) {
          // The real transport owns its correction. Injected callers emulate
          // that seam once with the original prompt and comparison identity.
          if (attempt + 1 < attempts && Array.isArray(error?.correctionDetails) && error.correctionDetails.length) {
            correction = { correctionDetails: [...error.correctionDetails], correctionRuleIds: [...(error.correctionRuleIds || [])], correctionAttempt: 1 };
            continue;
          }
          const decisionSignal = semanticMatching ? signal : member.rowBudget.signal;
          const code = ['comparative-unavailable', 'OFFICIAL_POSTING_COMPARATIVE_UNAVAILABLE'].includes(error?.code) ? 'comparative-unavailable'
            : error?.code === 'OFFICIAL_POSTING_COMPARATIVE_INVALID' || Array.isArray(error?.correctionDetails) ? 'comparative-invalid' : failureCode(error, decisionSignal);
          const failure = bridgeError(code === 'research-miss' ? 'comparative-invalid' : code);
          if (['bridge-aborted', 'bridge-timeout', 'bridge-unavailable', 'comparative-unavailable'].includes(failure.code)) matchFailure = failure;
          throw failure;
        }
      }
    };
    const match = async (job, options, context = {}) => {
      const input = { job, options, run: context.run, peerCandidates: context.peerCandidates,
        employerHypotheses: context.employerHypotheses, contradictionOnly: context.contradictionOnly };
      const request = semanticMatching ? buildSemanticOfficialPostingMatchRequest(input) : buildOfficialPostingMatchRequest(input);
      return callDecision(request, raw => semanticMatching
        ? validateSemanticOfficialPostingMatchResponse(raw, input) : validateOfficialPostingMatchResponse(raw, input), true);
    };
    match.handlesCorrections = true;
    const shortlist = async (job, candidates) => callDecision(buildSemanticOfficialPostingShortlistRequest({ job, candidates }),
      raw => validateSemanticOfficialPostingShortlistResponse(raw, { candidates }), false);
    shortlist.handlesCorrections = true;
    return { match, ...(semanticMatching ? { shortlist } : {}) };
  };
  for (const [batch, chunk] of chunks.entries()) for (const member of chunk) member.callbacks = callbacksFor(member, batch);
  const safeResolve = async (member, options) => {
    const rowSignal = semanticMatching ? signal : member.rowBudget.signal;
    if (rowSignal?.aborted) return unresolvedOfficialPosting(member.job, { outcome: 'failed', trail: [abortTrail(rowSignal)] });
    try {
      const result = await resolve(member.job, { store, fetch: session.fetch, signal: rowSignal, rowBudget: member.rowBudget,
        now: clock, persistResults: false, persistMisses: false, semanticMatching, bypassCache, candidateUrls,
        ...(semanticMatching ? member.callbacks : {}), ...options });
      if (!normalizeOfficialPosting(result?.officialPosting)) throw new TypeError('Invalid official posting resolution.');
      return result;
    } catch (error) {
      if (!rowSignal?.aborted) {
        stats.failed += 1;
        console.warn('[OfficialPosting] Row resolution failed:', error?.code || error?.name || 'Error');
      }
      return unresolvedOfficialPosting(member.job, { outcome: 'failed', trail: [rowSignal?.aborted ? abortTrail(rowSignal) : 'failed'] });
    }
  };
  const persist = async (member, result, { researchRan = false } = {}) => {
    // A row budget can end while the run continues. The shared predicate
    // requires a verified identity decision before a partial crawl is durable.
    const durability = VERIFIED_LEVELS.has(result.officialPosting?.level) ? signal : member.rowBudget.signal;
    if (!store || result.record || result.expiryCandidates?.length
      || result.officialPosting?.trail?.includes('recent-miss')
      || !shouldPersistOfficialPostingResult(result, { signal: durability, researchRan })) return result;
    try {
      const record = await store.save(member.job, { officialPosting: result.officialPosting, description: result.description });
      return { ...result, record, officialPosting: record.officialPosting };
    } catch (error) {
      stats.failed += 1;
      console.warn('[OfficialPosting] Resolution storage failed:', error?.code || error?.name || 'Error');
      return unresolvedOfficialPosting(member.job, { outcome: 'failed', trail: [...(result.officialPosting?.trail || []), 'failed'] });
    }
  };
  try {
    progress();
    await parallelRows(members, async member => {
      let result = await safeResolve(member);
      if (VERIFIED_LEVELS.has(result.officialPosting?.level)) result = await persist(member, result);
      results.set(member, result);
      if (VERIFIED_LEVELS.has(result.officialPosting?.level) || result.officialPosting?.trail?.includes('recent-miss') || member.rowBudget.signal.aborted) settle(member);
    });
    for (let batch = 0; batch < chunks.length; batch += 1) {
      const chunk = chunks[batch];
      const pending = chunk.filter(member => !finished.has(member));
      if (pending.length === 0) continue;
      if (signal?.aborted || !bridgeAvailable) {
        for (const member of pending) {
          const result = addTrail(results.get(member), signal?.aborted ? 'bridge-aborted' : 'bridge-unavailable');
          results.set(member, await persist(member, result)); settle(member);
        }
        continue;
      }
      let leads;
      try {
        const request = buildOfficialPostingResearchRequest(chunk.map(member => member.job));
        const raw = await cappedHandoff(request, { call: callRaw, signal, timeoutMs, manualAiRunId, nodeId,
          hints: { itemCount: chunk.length, batch: batch + 1, batchTotal: chunks.length }, now: clock, stats });
        leads = new Map(parseOfficialPostingResearchResponse(raw, chunk.map(member => member.id)).map(row => [row.id, row.candidates]));
      } catch (error) {
        for (const member of pending) {
          results.set(member, await persist(member, addTrail(results.get(member), failureCode(error, signal)))); settle(member);
        }
        continue;
      }
      await parallelRows(pending, async member => {
        if (signal?.aborted || member.rowBudget.signal.aborted) {
          results.set(member, addTrail(results.get(member), abortTrail(member.rowBudget.signal))); settle(member); return;
        }
        let result = await safeResolve(member, { candidateUrls: [...candidateUrls, ...(leads.get(member.id) || [])],
          bypassCache: true, ...member.callbacks, researchRan: true });
        result = addTrail(result, 'bridge-research');
        results.set(member, await persist(member, result, { researchRan: true })); settle(member);
      });
    }
    for (const member of members) {
      let result = results.get(member);
      if (TEXT_LEVELS.has(result.officialPosting?.level)) {
        let description = result.description;
        if (!description && store && result.officialPosting.contentHash) try { description = await store.readText(result.officialPosting.contentHash); } catch { /* The view handles missing/corrupt text. */ }
        if (materiallyDifferent(member.job.snippet || member.job.description, description)) {
          result = addTrail(result, 'material-jd-change'); stats.materialJdChange += 1;
          // A newer complete proof wins over feedback about an older record.
          if (store && result.record && shouldPersistOfficialPostingResult(result, { signal })) try {
            const record = await store.save(member.job, { officialPosting: result.officialPosting, expectedRecord: result.record });
            if (record) result = { ...result, record, officialPosting: record.officialPosting };
          } catch { /* Telemetry and row retain the detected change. */ }
          results.set(member, result);
        }
      }
      countPosting(stats, result?.officialPosting || unresolvedOfficialPosting(member.job, { outcome: 'failed', trail: ['failed'] }).officialPosting, result?.comparison);
    }
    const finalFetchStats = session.telemetry();
    for (const key of FETCH_COUNTERS) stats[key] = Math.max(0, count(finalFetchStats[key]) - count(initialFetchStats[key]));
    stats.maxPerHostRate = count(finalFetchStats.maxPerHostRate);
    const byJob = new Map([...results].map(([member, result]) => [member.job, result]));
    const resolved = rows.map(job => { const result = byJob.get(job); return { ...job, postedBy: result?.postedBy,
      officialPosting: normalizeOfficialPosting(result?.officialPosting) || undefined }; });
    if (telemetry && typeof telemetry === 'object') telemetry.officialPosting = stats;
    return { jobs: resolved, telemetry: stats,
      expiryCandidates: rows.map(job => byJob.get(job)?.expiryCandidates || []) };
  } finally {
    for (const member of members) member.rowBudget.dispose();
    if (!fetchSession) session.dispose?.();
  }
}

function atsPostingKey(posting) {
  const value = officialHttpsUrl(posting.sourceUrl);
  if (!value) return '';
  const url = new URL(value); const route = extractAtsTenant(value)
    || (posting.ats === 'teamtailor' && posting.tenant === url.hostname ? { ats: 'teamtailor', tenant: url.hostname } : null);
  if (!route) return '';
  const parts = url.pathname.split('/').filter(Boolean);
  let id = '';
  if (['ashby', 'lever'].includes(route.ats)) id = parts[1] || '';
  if (route.ats === 'greenhouse') id = url.searchParams.get('gh_jid') || url.searchParams.get('token') || (parts.includes('jobs') ? parts[parts.indexOf('jobs') + 1] : '') || '';
  if (route.ats === 'teamtailor') id = parts[0] === 'jobs' ? parts[1]?.match(/^\d+/u)?.[0] || parts[1] : '';
  if (route.ats === 'workday') id = parts.at(-1)?.match(/(?:^|_)(R[\p{L}\p{N}-]+)$/iu)?.[1] || '';
  if (route.ats === 'icims') id = parts[0] === 'jobs' ? parts[1] || '' : '';
  return id ? `${route.ats}|${route.tenant}|${id}` : '';
}

/** First wins, except an employer's own official URL beats its board mirror. */
export function officialPostingDedup(jobs) {
  const kept = []; const dropped = []; const urls = new Map(); const ids = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const posting = normalizeOfficialPosting(job?.officialPosting);
    if (!posting || !TEXT_LEVELS.has(posting.level)) { kept.push(job); continue; }
    const url = officialHttpsUrl(posting.sourceUrl); const id = atsPostingKey(posting);
    const prior = (url && urls.get(url)) || (id && ids.get(id));
    if (!prior) { kept.push(job); if (url) urls.set(url, job); if (id) ids.set(id, job); continue; }
    const ownOfficial = officialHttpsUrl(job.url) === url;
    const priorOwnOfficial = officialHttpsUrl(prior.url) === officialHttpsUrl(prior.officialPosting.sourceUrl);
    const winner = ownOfficial && !priorOwnOfficial ? job : prior;
    const loser = winner === job ? prior : job;
    if (winner === job) kept[kept.indexOf(prior)] = job;
    for (const [key, value] of urls) if (value === prior) urls.set(key, winner);
    for (const [key, value] of ids) if (value === prior) ids.set(key, winner);
    if (url) urls.set(url, winner); if (id) ids.set(id, winner);
    dropped.push({ kept: winner, dropped: loser, reason: officialHttpsUrl(prior.officialPosting.sourceUrl) === url ? 'official-url' : 'official-ats-id', stage: 'official-posting' });
  }
  return { kept, dropped };
}
