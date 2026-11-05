import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import electronPkg from 'electron';
import { ensureDirectoryWithinRoot } from '../utils/pathSafety.js';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';
import { callLLMRaw } from './llm.js';
import { createOfficialPostingStore, officialPostingView, officialPostingRecordMatchesScrapedIdentity, officialPostingAliases } from './officialPostingStore.js';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { createOfficialPostingFetchSession } from './officialPostingFetchSession.js';
import { extractOfficialPostingCandidates } from './officialPostingExtractors.js';
import { officialPostingAdapterUrl, officialPostingChunks, unresolvedOfficialPosting, shouldPersistOfficialPostingResult } from './officialPostingResolver.js';
import { canonicalLeadUrl, descriptionOverlap } from './officialPostingMatch.js';
import { officialPostingSemanticInputHash, officialPostingSemanticProofMatches } from './officialPostingSemantic.js';
import { extractAtsTenant, isAggregatorHost, isHostedAtsSurface, normalizedSourceHost, strictEmployerEqual } from './officialSourceHosts.js';
import { normalizeOfficialPosting, officialHttpsUrl, boundedOfficialPostingTrail, officialPostingComparativeTrail, OFFICIAL_POSTING_LEVELS, OFFICIAL_POSTING_OUTCOMES, OFFICIAL_POSTING_TRAIL, OFFICIAL_POSTING_COMPARATIVE_CODES } from './officialPostingFields.js';
import { mergeListingLivenessTelemetry } from './listingLivenessTelemetry.js';
import { mergeBoardClosedTelemetry } from './officialPostingBoardClosed.js';
import { buildOfficialPostingResearchRequest, parseOfficialPostingResearchResponse } from './officialPostingBridge.js';
import { CLAUDE_TASK_CONCURRENCY } from './claudeTaskWorker.js';
import { createOfficialPostingReadMonitor } from './officialPostingReadHealth.js';
import { snapshotOfficialPostingLeads, trimOfficialPostingSnapshots } from './officialPostingSnapshot.js';
import { createOfficialPostingRenderSession, renderOfficialPostingPage } from './officialPostingRenderedPage.js';
import { buildOfficialPostingJudgeRequest, decideOfficialPostingJudgments, rankJudgeCitations, validateOfficialPostingJudgeResponse, MAX_JUDGE_LEADS, UNREADABLE_PAGE_TEXT_CHARS } from './officialPostingJudge.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from './officialPostingNegativePolicy.js';
import { officialPostingHandoffFailureCause, officialPostingHandoffFailureCode, recordOfficialPostingDiscovery } from './officialPostingDiscoveryDiagnostics.js';

export const OFFICIAL_POSTING_HANDOFF_TIMEOUT_MS = 20 * 60 * 1_000;
export const OFFICIAL_POSTING_HANDOFF_ASSIGNMENT_TIMEOUT_MS = 20 * 60 * 1_000;
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

function workerError(code) { const error = new Error(code); error.code = code; return error; }
function failureCode(error, signal) {
  const classified = officialPostingHandoffFailureCode(error, signal);
  if (signal?.aborted) return ['worker-timeout', 'request-timeout'].includes(classified) ? 'worker-timeout' : 'worker-aborted';
  if (classified === 'request-timeout') return 'worker-timeout';
  if (['sender-destroyed', 'renderer-stopped', 'renderer-navigated', 'abort-error'].includes(classified)) return 'worker-aborted';
  if (['worker-timeout', 'worker-aborted', 'worker-unavailable'].includes(classified)) return classified;
  if (error?.code === 'worker-unavailable') return 'worker-unavailable';
  if (['worker-lost', 'worker-replaced', 'comparison-contaminated', 'fresh-context-required', 'requeue-exhausted', 'renderer-unavailable']
    .includes(classified)) return 'worker-unavailable';
  return 'research-miss';
}

function comparativeFailureCode(error, signal) {
  const code = officialPostingHandoffFailureCode(error, signal);
  if (['comparative-unavailable', 'comparative-invalid'].includes(code)) return code;
  const failure = failureCode(error, signal);
  // An unexpected transport/programming error is not evidence of an invalid AI answer.
  return failure === 'research-miss' ? 'failed' : failure;
}

export async function cappedHandoff(request, { call, signal, timeoutMs, manualAiRunId, nodeId, hints, now, stats,
  timeoutStartsOnAssignment = call === callLLMRaw,
  unassignedTimeoutMs = OFFICIAL_POSTING_HANDOFF_ASSIGNMENT_TIMEOUT_MS }) {
  const assignmentTimed = timeoutStartsOnAssignment;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || workerError('worker-aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let timer = null; let assignmentTimer = null; let finished = false;
  const startTimeout = () => {
    if (finished || controller.signal.aborted || timer !== null) return;
    clearTimeout(assignmentTimer); assignmentTimer = null;
    timer = setTimeout(() => controller.abort(workerError('worker-timeout')), timeoutMs);
    timer.unref?.();
  };
  // Queue waiting has its own generous ceiling. Only assignment starts the
  // response budget, even after another module's turn.
  if (assignmentTimed) {
    if (Number.isFinite(unassignedTimeoutMs) && unassignedTimeoutMs >= 0) {
      assignmentTimer = setTimeout(() => controller.abort(workerError('worker-timeout')), unassignedTimeoutMs);
      assignmentTimer.unref?.();
    }
  } else if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    timer = setTimeout(() => controller.abort(workerError('worker-timeout')), timeoutMs);
    timer.unref?.();
  }
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason || workerError('worker-aborted')); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  const start = now();
  stats.handoffs += 1;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const { prompt, ...options } = request;
    return await Promise.race([Promise.resolve().then(() => call(prompt, { ...options,
      ...(assignmentTimed ? { manualHandoff: { ...options.manualHandoff, onAssigned: (...args) => {
        try { options.manualHandoff?.onAssigned?.(...args); }
        finally { startTimeout(); }
      } } } : {}),
      signal: controller.signal, manualAiRunId, nodeId, hints: { ...options.hints, ...hints } })), cancelled]);
  } finally {
    finished = true;
    clearTimeout(timer); clearTimeout(assignmentTimer);
    signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort);
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
const REJECTION_CODES = Object.freeze(['title-mismatch', 'location-mismatch', 'employer-mismatch', 'tenant-unproven', 'source-unproven', 'poster-tenant', 'salary-mismatch', 'no-anchor', 'invalid-quotes', 'ambiguous', 'closed', 'unreadable', 'oversize', 'unsafe-url', 'unsafe-address', 'fetch-timeout', 'fetch-failed', 'unsupported-content-type', 'invalid-text', 'crawl-budget', 'crawl-partial', 'semantic-uncertain', 'semantic-overflow', ...OFFICIAL_POSTING_COMPARATIVE_CODES]);
const FETCH_COUNTERS = Object.freeze(['fetches', 'uniqueUrls', 'cacheHits', 'breakerTrips']);
const MISS_TTL_MS = 24 * 60 * 60 * 1_000;
const ROW_CONCURRENCY = 6;
function telemetryBlock() {
  return { total: 0, levels: Object.fromEntries(OFFICIAL_POSTING_LEVELS.map(level => [level, 0])),
    outcomes: Object.fromEntries(OFFICIAL_POSTING_OUTCOMES.map(outcome => [outcome, 0])), rejections: {},
    handoffs: 0, handoffMs: 0, failed: 0, materialJdChange: 0, workerTimeout: 0, workerUnavailable: 0,
    comparisons: 0, comparisonOptions: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, 0])),
    comparativeAgreements: 0, comparativeDisagreements: 0, comparativeInvalidRuns: 0,
    comparativeNone: 0, comparativeUnavailable: 0, comparativeMatches: 0,
    fetches: 0, uniqueUrls: 0, cacheHits: 0, maxPerHostRate: 0, breakerTrips: 0 };
}
function countPosting(stats, posting, comparison = null) {
  stats.total += 1;
  stats.levels[posting.level] += 1; stats.outcomes[posting.outcome] += 1;
  for (const code of new Set(posting.trail || [])) {
    if (code === 'worker-timeout') stats.workerTimeout += 1;
    if (code === 'worker-unavailable') stats.workerUnavailable += 1;
    if (!['comparative-match', 'comparative-equivalent'].includes(code) && REJECTION_CODES.includes(code)) stats.rejections[code] = (stats.rejections[code] || 0) + 1;
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
    for (const code of REJECTION_CODES) if (!['comparative-match', 'comparative-equivalent'].includes(code) && count(block.rejections?.[code])) result.rejections[code] = (result.rejections[code] || 0) + count(block.rejections[code]);
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
  return OFFICIAL_POSTING_TRAIL.includes(signal?.reason?.code) ? signal.reason.code : 'worker-aborted';
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
    if (posting.outcome === 'closed') return;
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
    if (signal?.aborted) throw signal.reason || workerError('worker-aborted');
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
      if (signal?.aborted) throw signal.reason || workerError('worker-aborted');
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

/** A saved decision for this exact scraped input settles the row without new chats: a verified posting, or a
 * recent settled miss (the store's 24-hour window). A closed record is researched again for a replacement. */
async function cachedChatResolution(job, store) {
  let record;
  try { record = await store.find(job); } catch { return null; }
  const posting = normalizeOfficialPosting(record?.officialPosting);
  if (!posting || !officialPostingRecordMatchesScrapedIdentity(job, record) || !officialPostingSemanticProofMatches(job, posting)
    || !shouldPersistOfficialPostingResult({ officialPosting: posting }, { researchRan: true })) return null;
  if (VERIFIED_LEVELS.has(posting.level) && ['found', 'link-only'].includes(posting.outcome)) {
    return { record, postedBy: strictEmployerEqual(posting.employer, job?.company) ? '' : String(job?.company || ''),
      officialPosting: { ...posting, trail: boundedOfficialPostingTrail([...(posting.trail || []), 'cache-hit']) } };
  }
  if (!VERIFIED_LEVELS.has(posting.level) && !posting.trail?.includes('closed')) {
    return { record, postedBy: unresolvedOfficialPosting(job).postedBy,
      officialPosting: { ...posting, trail: boundedOfficialPostingTrail([...(posting.trail || []), 'recent-miss']) } };
  }
  return null;
}

/** Leads for the judges: a prior verified page first (a recheck), then supplied leads, then the finders' postings and
 * their careers pages. Pointers only; the app downloads each one (snapshots) and the judges read what it returned. */
function judgeLeadsFor(member, found) {
  const leads = []; const seen = new Set();
  const add = (value, kind, employer = '', confirmed = {}) => {
    const url = officialHttpsUrl(value); const key = canonicalLeadUrl(url);
    if (!url || !key || seen.has(key)) return;
    seen.add(key);
    // A job board's own public data for this posting: the page itself usually needs JavaScript, which a plain download
    // cannot run. The snapshot step downloads it as well.
    const route = kind === 'posting' ? extractAtsTenant(url) : null;
    let dataUrl = '';
    try { dataUrl = route ? officialHttpsUrl(officialPostingAdapterUrl(route, url)) : ''; } catch { dataUrl = ''; }
    leads.push({ url, kind, employer: String(employer || ''), ...(dataUrl && dataUrl !== url ? { dataUrl } : {}), ...confirmed });
  };
  const prior = normalizeOfficialPosting(member.priorOfficialRecord?.officialPosting);
  // Only a verification of this same listing counts: the judges may then accept that its page has gone without any text to compare.
  const confirmedEarlier = prior && VERIFIED_LEVELS.has(prior.level) && ['found', 'link-only'].includes(prior.outcome)
    && officialPostingSemanticProofMatches(member.job, prior);
  add(prior?.sourceUrl, 'posting', prior?.employer, confirmedEarlier ? { confirmedEarlier: true, title: prior.title } : {});
  add(prior?.officialApplyUrl, 'posting', prior?.employer);
  // Addresses earlier judges cited stay leads: a new search may not find them again, and the page itself can settle them.
  for (const item of prior?.alternatives || []) if (item?.title?.startsWith('Unconfirmed · cited')) add(item.url, 'posting', prior?.employer);
  for (const lead of member.candidateUrls) {
    if (typeof lead === 'string') add(lead, 'posting');
    else { add(lead?.postingUrl || lead?.url, 'posting', lead?.employer); add(lead?.careersPageUrl, 'careers', lead?.employer); }
  }
  for (const lead of found) add(lead.postingUrl, 'posting', lead.employer);
  for (const lead of found) add(lead.careersPageUrl, 'careers', lead.employer);
  // The employer's own site, for a job the finders placed only on a job board: its pages are where a judge sees that board linked.
  // Never at the cost of a lead the judges would otherwise read: a cut lead leaves a miss unprovable, and the last slot waits for an address a first-round judge names.
  for (const lead of [...member.candidateUrls, ...found]) {
    const site = officialHttpsUrl(lead?.employerDomain); const host = site ? normalizedSourceHost(site).replace(/^www\./u, '') : '';
    if (!host || leads.length >= MAX_JUDGE_LEADS - 1 || isAggregatorHost(host) || isHostedAtsSurface(host)
      || leads.some(item => { const other = normalizedSourceHost(item.url); return other === host || other.endsWith(`.${host}`); })) continue;
    add(site, 'careers', lead.employer);
  }
  return { total: leads.length, leads: leads.slice(0, MAX_JUDGE_LEADS).map((lead, index) => ({ id: `P${index + 1}`, ...lead })) };
}

const JUDGMENT_LOG_BYTES = 2 * 1024 * 1024;
/** The judges' own answers (choice, status, link, URL, explanation), so an unsettled lookup can be diagnosed afterwards.
 * Bounded: the file rolls over to one previous copy. Never part of any decision. */
async function recordJudgment(store, entry) {
  if (!store?.rootDir) return;
  try {
    const fs = await import('node:fs/promises');
    // A forced first refresh can skip cache reads, which normally prepare the
    // store. Keep its earliest failures diagnosable before any result is saved.
    await ensureDirectoryWithinRoot(path.dirname(store.rootDir), store.rootDir, { label: 'Official posting store' });
    const file = path.join(store.rootDir, 'judgments.jsonl');
    const size = await fs.stat(file).then(stat => stat.size, () => 0);
    if (size > JUDGMENT_LOG_BYTES) await fs.rename(file, `${file}.1`);
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch { /* Diagnostics must not affect the lookup. */ }
}

/** Claude does all finding and judging. The host sends handoffs, checks each answer's format and quotes,
 * compares the two judgments (each its own session) for equality, and stores the agreed result. */
export async function resolveOfficialPostings(jobs, {
  manualAiRunId, nodeId, signal, callRaw = callLLMRaw, callMatch = callRaw, onProgress, telemetry,
  store, now = Date.now, snapshotFetch = fetchOfficialPosting,
  // Injected downloads mean a test or offline replay, which must never open a browser unless it supplies one.
  snapshotRender = snapshotFetch === fetchOfficialPosting ? renderOfficialPostingPage : null, bypassCache = false, bypassCacheByRow = [], candidateUrls = [], candidateUrlsByRow = [],
  priorOfficialRecords = [], timeoutMs = OFFICIAL_POSTING_HANDOFF_TIMEOUT_MS,
  timeoutStartsOnAssignment,
} = {}) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const members = officialPostingChunks(rows).flat();
  const clock = () => typeof now === 'function' ? Number(now()) : Number(now);
  const stats = telemetryBlock();
  const results = new Map(); const finished = new Set(); const found = new Map();
  const discovery = new Map(members.map(member => [member, { finderCalls: 0, judgeRounds: 0, judgeCalls: 0,
    comparisonRuns: 0, snapshotReads: 0, snapshotFailures: 0, truncatedSnapshots: 0, postingDataSnapshots: 0, renderedSnapshots: 0, renderFailures: 0, failureCodes: [] }]));
  for (const member of members) {
    const index = rows.indexOf(member.job);
    member.priorOfficialRecord = priorOfficialRecords[index] || null;
    member.bypassCache = bypassCache || bypassCacheByRow[index] === true;
    member.candidateUrls = [...candidateUrls, ...(Array.isArray(candidateUrlsByRow[index]) ? candidateUrlsByRow[index] : [])];
  }
  try { store ||= getOfficialPostingStore(); } catch { store = null; }
  const progress = () => { try { onProgress?.({ completed: finished.size, total: rows.length }); } catch { /* Progress cannot fail the search. */ } };
  const settle = (member, result) => {
    results.set(member, result); finished.add(member);
    // Cached rows do not describe a new attempt; a new one records its final counts.
    if (!result?.officialPosting?.trail?.some(code => ['cache-hit', 'recent-miss'].includes(code))) {
      const counts = discovery.get(member);
      recordOfficialPostingDiscovery(member.job, { candidateCount: judgeLeadsFor(member, found.get(member) || []).total,
        outcome: result?.officialPosting?.outcome,
        settled: shouldPersistOfficialPostingResult(result, { signal, researchRan: true }),
        comparisonRuns: counts.comparisonRuns, chatStats: counts,
        failureCodes: counts.failureCodes,
        resolutionReasons: result?.officialPosting?.trail });
    }
    progress();
  };
  const unresolved = (member, trail) => unresolvedOfficialPosting(member.job, { outcome: 'ambiguous', trail });
  const persist = async (member, result) => {
    if (!store || result.record || result.officialPosting?.trail?.includes('recent-miss')
      || !shouldPersistOfficialPostingResult(result, { signal, researchRan: true })) return result;
    try {
      const record = await store.save(member.job, { officialPosting: result.officialPosting, description: result.description });
      return { ...result, record, officialPosting: record.officialPosting };
    } catch (error) {
      stats.failed += 1;
      console.warn('[OfficialPosting] Resolution storage failed:', error?.code || error?.name || 'Error');
      return { ...unresolvedOfficialPosting(member.job, { outcome: 'failed', trail: [...(result.officialPosting?.trail || []), 'storage-failed'] }),
        comparison: result.comparison };
    }
  };
  // The queue is admitted up to the Claude task worker's concurrency.
  const handoffQueue = [];
  let activeHandoffs = 0; let activeComparisons = 0; let discoveryPending = true; let draining = false;
  const handoffCapacity = () => CLAUDE_TASK_CONCURRENCY;
  const drainHandoffs = () => {
    if (draining) return;
    draining = true;
    try {
      const capacity = handoffCapacity();
      while (activeHandoffs < capacity && handoffQueue.length) {
        // Reserve a worker throughout both discovery rounds, including gaps
        // between batches. Early judgments may use only the spare capacity.
        let index = handoffQueue.findIndex(item => !item.comparative);
        if (index < 0) {
          if (discoveryPending && activeComparisons >= capacity - 1) break;
          index = 0;
        }
        const item = handoffQueue.splice(index, 1)[0];
        item.cleanup(); activeHandoffs += 1;
        if (item.comparative) activeComparisons += 1;
        void item.dispatch(item.request, { call: item.comparative ? callMatch : callRaw, signal, timeoutMs,
          manualAiRunId, nodeId, hints: item.hints, now: clock, stats, timeoutStartsOnAssignment })
          .then(item.resolve, item.reject).finally(() => {
            activeHandoffs -= 1;
            if (item.comparative) activeComparisons -= 1;
            drainHandoffs();
          });
      }
    } finally { draining = false; }
  };
  const handoff = (request, hints, comparative) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || workerError('worker-aborted')); return; }
    // Worker publications execute under the publisher's async context, which
    // can have no IPC owner or belong to another canvas/run. Preserve the
    // enqueueing invoke's sender and durable run identity per handoff.
    const item = { request, hints, comparative, resolve, reject, dispatch: AsyncLocalStorage.bind(cappedHandoff) };
    const onAbort = () => {
      const index = handoffQueue.indexOf(item);
      if (index >= 0) handoffQueue.splice(index, 1);
      item.cleanup(); reject(signal.reason || workerError('worker-aborted'));
    };
    item.cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    handoffQueue.push(item);
    drainHandoffs();
  });
  // Finders: grounded research batches. A row the first finder could not place gets one more independent search.
  const findLeads = async (group, round) => {
    // Cards with the same scraped identity share one research slot and its answer.
    const byId = new Map();
    for (const member of group) byId.set(member.id, [...(byId.get(member.id) || []), member]);
    const chunks = officialPostingChunks([...byId.values()].map(([first]) => first.job));
    for (const [batch, chunk] of chunks.entries()) {
      const chunkMembers = chunk.flatMap(({ id }) => byId.get(id) || []);
      if (signal?.aborted) {
        for (const member of chunkMembers) settle(member, unresolved(member, [abortTrail(signal)]));
        continue;
      }
      try {
        for (const member of chunkMembers) discovery.get(member).finderCalls += 1;
        const raw = await handoff(buildOfficialPostingResearchRequest(chunk.map(({ job }) => job)),
          { itemCount: chunk.length, batch: batch + 1, batchTotal: chunks.length, ...(round > 1 ? { attemptKind: 'second-search' } : {}) }, false);
        for (const row of parseOfficialPostingResearchResponse(raw, chunk.map(({ id }) => id))) {
          for (const member of byId.get(row.id) || []) found.set(member, [...(found.get(member) || []), ...row.candidates]);
        }
        for (const member of chunkMembers) if (judgeLeadsFor(member, found.get(member) || []).total) queueJudgment(member);
      } catch (error) {
        // A failed second search keeps whatever the first one found.
        const code = failureCode(error, signal);
        for (const member of chunkMembers) {
          discovery.get(member).failureCodes.push(officialPostingHandoffFailureCode(error, signal), officialPostingHandoffFailureCause(error));
          if (round === 1 || code !== 'research-miss') settle(member, unresolved(member, [code]));
        }
      }
    }
  };
  // Each judge keeps its own transport identity and correction state. The two
  // judges overlap when the worker runs more than one task at a time.
  // What each judge was given, as counts and flags, so a later miss can be told apart from an unreadable page.
  const snapshotLog = snapshots => snapshots.map(snapshot => ({ id: snapshot.id, source: snapshot.source, read: snapshot.read === true,
    ...(snapshot.rendered ? { rendered: true } : {}), ...(snapshot.settled === false ? { settled: false } : {}),
    ...(snapshot.renderFailed ? { renderFailed: snapshot.renderFailed } : {}),
    ...(typeof snapshot.listedInBoardData === 'boolean' ? { listed: snapshot.listedInBoardData } : {}),
    ...(snapshot.httpStatus ? { httpStatus: snapshot.httpStatus } : {}), ...(snapshot.notFound ? { notFound: true } : {}),
    descriptionChars: String(snapshot.description || '').length, pageTextChars: String(snapshot.pageText || '').length,
    boardLinks: snapshot.jobBoardLinks?.length || 0 }));
  const judgePair = async (member, leads, round, snapshots) => {
    const counts = discovery.get(member);
    counts.judgeRounds += 1;
    const runJudge = async run => {
      const request = buildOfficialPostingJudgeRequest({ job: member.job, leads, run, round, snapshots });
      const attempts = callMatch === callLLMRaw ? 1 : 2;
      let correction = {}; let failure = null; let failureClass = null; let failureCause = null; let answer;
      // The registry reports the actual restored/adopted route if reached,
      // including why a legacy manual state blocked admission.
      let route = 'mcp'; let manualRoutingReason = null;
      const onRoute = value => {
        route = value.route;
        manualRoutingReason = value.manualRoutingReason;
      };
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          counts.judgeCalls += 1;
          answer = validateOfficialPostingJudgeResponse(await handoff({ ...request, ...correction,
            manualHandoff: { ...request.manualHandoff, onRoute } },
            { itemCount: 1, optionCount: leads.length, comparisonRun: run }, true), { job: member.job, leads });
          counts.comparisonRuns += 1;
          failure = null;
          await recordJudgment(store, { at: new Date(clock()).toISOString(), card: member.id, title: String(member.job?.title || '').slice(0, 200),
            company: String(member.job?.company || '').slice(0, 120), round, run, route, manualRoutingReason, leads: leads.map(lead => lead.url),
            choice: answer.choice, status: answer.status, statusQuote: answer.statusQuote, employerLinked: answer.employerLinked,
            employerPageUrl: answer.employerPageUrl, postingUrl: answer.postingUrl, judgeTitle: answer.title.slice(0, 200), judgeEmployer: answer.employer.slice(0, 120), descriptionChars: answer.description.length,
            conflicts: answer.conflicts, snapshots: snapshotLog(snapshots) });
          break;
        } catch (error) {
          // The real transport owns its correction rounds; injected callers emulate one with the same identity.
          if (attempt + 1 < attempts && Array.isArray(error?.correctionDetails) && error.correctionDetails.length) {
            correction = { correctionDetails: [...error.correctionDetails], correctionRuleIds: [...(error.correctionRuleIds || [])], correctionAttempt: 1 };
            continue;
          }
          failureClass = officialPostingHandoffFailureCode(error, signal);
          failureCause = officialPostingHandoffFailureCause(error);
          counts.failureCodes.push(failureClass, failureCause);
          failure = comparativeFailureCode(error, signal);
        }
      }
      if (failure) await recordJudgment(store, { at: new Date(clock()).toISOString(), card: member.id, title: String(member.job?.title || '').slice(0, 200),
        company: String(member.job?.company || '').slice(0, 120), round, run, route, manualRoutingReason, leads: leads.map(lead => lead.url), failure: failureClass,
        ...(failureCause ? { failureCause } : {}), snapshots: snapshotLog(snapshots) });
      return { run, answer, failure };
    };
    const parallel = CLAUDE_TASK_CONCURRENCY >= 2;
    const runs = parallel ? await Promise.all(['A', 'B'].map(runJudge)) : [await runJudge('A')];
    if (!parallel && !runs[0].failure) runs.push(await runJudge('B'));
    // Assemble in A/B order, independent of response completion order. A's
    // failure takes precedence when both independent runs fail.
    const answers = {}; const valid = { A: false, B: false };
    for (const result of runs) if (!result.failure) { answers[result.run] = result.answer; valid[result.run] = true; }
    const failure = runs.find(result => result.failure)?.failure;
    if (failure) return { answers, failed: { ...unresolved(member, ['worker-research', ...officialPostingComparativeTrail({ validA: valid.A, validB: valid.B,
      choiceA: answers.A?.choice, choiceB: answers.B?.choice }), signal?.aborted ? abortTrail(signal) : failure]),
    comparison: { optionCount: leads.length, validA: valid.A, validB: valid.B, invalidRuns: Number(!valid.A) + Number(!valid.B),
      unavailable: failure === 'comparative-unavailable' } } };
    return { answers };
  };
  const judge = async member => {
    const initial = judgeLeadsFor(member, found.get(member) || []);
    let { leads } = initial; const { total } = initial;
    if (!leads.length) return unresolved(member, ['worker-research', 'research-miss']);
    // One download of every lead, shared by both rounds: it is the judges' main input, since WebFetch cannot run JavaScript.
    let snapshots = signal?.aborted ? [] : await snapshotOfficialPostingLeads(leads, { fetch: snapshotSession.fetch, render: renderSession, signal, observe: readHealth.observe });
    const counts = discovery.get(member);
    counts.snapshotReads = snapshots.filter(snapshot => snapshot.read === true).length;
    counts.snapshotFailures = snapshots.filter(snapshot => snapshot.read !== true).length;
    counts.truncatedSnapshots = snapshots.filter(snapshot => snapshot.descriptionTruncated || snapshot.pageTextTruncated).length;
    // A read page can be an empty shell. Only these held a posting's own fields rather than the whole page's text.
    counts.postingDataSnapshots = snapshots.filter(snapshot => snapshot.read === true && (snapshot.title || snapshot.description)).length;
    counts.renderedSnapshots = snapshots.filter(snapshot => snapshot.rendered === true).length;
    counts.renderFailures = snapshots.filter(snapshot => snapshot.renderFailed).length;
    const decide = answers => decideOfficialPostingJudgments(member.job, { leads, totalLeads: total, snapshots, answerA: answers.A, answerB: answers.B, now: clock,
      fallback: unresolvedOfficialPosting, comparativeTrail: officialPostingComparativeTrail,
      inputHash: officialPostingSemanticInputHash(member.job), extractRoute: url => extractAtsTenant(url),
      employerEqual: strictEmployerEqual, negativeProofTrail: OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL, closureNeedsRenderedPage: Boolean(renderSession) });
    const first = await judgePair(member, leads, 1, snapshots);
    if (first.failed) return first.failed;
    const answers = Object.values(first.answers);
    const namedInConflicts = list => list.filter(answer => ['none', 'uncertain'].includes(answer?.choice))
      .flatMap(answer => (answer.conflicts || []).flatMap(text => text.match(/https:\/\/[^\s"'<>)\]]+/gu) || [])
        .map(url => ({ answer, cited: url.replace(/[^\p{L}\p{N}/=#&%_~-]+$/u, '') })));
    let named = [];
    const withCitations = result => {
      if (result.officialPosting?.outcome !== 'ambiguous') return result;
      const alternatives = rankJudgeCitations({ leads, answers, named, sourceUrls: [member.job?.url, member.job?.applyUrl] });
      return alternatives.length ? { ...result, officialPosting: { ...result.officialPosting, alternatives } } : result;
    };
    const decided = decide(first.answers);
    // A pair that did not settle (they differed, or could not confirm status or the employer's link) gets one more
    // independent pair, and so does a pair that found nothing or found it closed: a miss or a closure is final only
    // when a second pair says so too. Only that second pair's own agreement can settle the row; the first pair's answers never count.
    const retryable = ['semantic-uncertain', 'official-liveness-unconfirmed', 'source-unproven', 'comparative-none']
      .some(code => decided.officialPosting?.trail?.includes(code)) || decided.officialPosting?.outcome === 'closed';
    if (!retryable || signal?.aborted) return withCitations(decided);
    // A page a first judge found by its own search gets the same full-page read before the second pair judges it.
    const known = new Set(leads.map(lead => canonicalLeadUrl(lead.url)));
    const added = [];
    // Pages a judge actually read come first, then ones it could only name, without the markup or punctuation around them.
    const judgeOwnPostings = answers.filter(answer => answer?.choice === 'other').map(answer => ({ answer, cited: answer.postingUrl }));
    const judgeNamed = namedInConflicts(answers);
    for (const { answer, cited } of [...judgeOwnPostings, ...judgeNamed]) {
      const url = officialHttpsUrl(cited);
      if (!url || isAggregatorHost(normalizedSourceHost(url)) || known.has(canonicalLeadUrl(url)) || leads.length + added.length >= MAX_JUDGE_LEADS) continue;
      known.add(canonicalLeadUrl(url));
      added.push({ id: `P${leads.length + added.length + 1}`, url, kind: 'posting', employer: String(answer.employer || '') });
    }
    if (added.length) {
      leads = [...leads, ...added];
      snapshots = trimOfficialPostingSnapshots([...snapshots, ...await snapshotOfficialPostingLeads(added, { fetch: snapshotSession.fetch, render: renderSession, signal, observe: readHealth.observe })]);
    }
    const second = await judgePair(member, leads, 2, snapshots);
    answers.push(...Object.values(second.answers));
    // A miss or a closure never settles on one pair: without the confirming pair it stays retryable.
    if (second.failed) return decided.officialPosting?.trail?.includes('comparative-none') || decided.officialPosting?.outcome === 'closed'
      ? second.failed : withCitations(decided);
    // Where a lead's own redirect ended and the app read a page is that lead's page, not a new address. A shell it couldn't read still counts as unread.
    const reached = new Set(snapshots.filter(snapshot => snapshot.read === true && (snapshot.description || String(snapshot.pageText || '').length >= UNREADABLE_PAGE_TEXT_CHARS))
      .map(snapshot => canonicalLeadUrl(snapshot.finalUrl)).filter(Boolean));
    named = namedInConflicts(Object.values(second.answers)).map(item => item.cited).filter(url => !reached.has(canonicalLeadUrl(url)));
    return withCitations(decide(second.answers));
  };
  const judgmentQueue = []; const judgmentTasks = []; const scheduledJudgments = new Set();
  let activeJudgments = 0;
  const runJudgment = async member => {
    let result;
    try { result = signal?.aborted ? unresolved(member, [abortTrail(signal)]) : await judge(member); }
    catch (error) {
      stats.failed += 1;
      console.warn('[OfficialPosting] Row judgment failed:', error?.code || error?.name || 'Error');
      result = unresolvedOfficialPosting(member.job, { outcome: 'failed', trail: ['failed'] });
    }
    settle(member, await persist(member, result));
  };
  const drainJudgments = () => {
    while (activeJudgments < ROW_CONCURRENCY && judgmentQueue.length) {
      const { member, resolve, reject } = judgmentQueue.shift();
      activeJudgments += 1;
      void runJudgment(member).then(resolve, reject).finally(() => {
        activeJudgments -= 1;
        drainJudgments();
      });
    }
  };
  function queueJudgment(member) {
    if (finished.has(member) || scheduledJudgments.has(member)) return;
    scheduledJudgments.add(member);
    const task = new Promise((resolve, reject) => judgmentQueue.push({ member, resolve, reject }));
    // Discovery continues while rows work, so retain failures for the final
    // join without creating an unhandled rejection in that interval.
    void task.catch(() => {});
    judgmentTasks.push(task);
    drainJudgments();
  }
  // One invocation shares successful/in-flight downloads across rows. Failure
  // results never outlive their subscribers, and a later lookup starts fresh.
  const snapshotSession = createOfficialPostingFetchSession({ fetch: snapshotFetch, signal, cacheFailures: false, hostBreaker: false });
  // Injected downloads are a test or replay, which must not raise alarms about the real network.
  const readHealth = snapshotFetch === fetchOfficialPosting ? createOfficialPostingReadMonitor({ signal }) : { observe: undefined, flush() {} };
  // One job is someone waiting on this card (Generate or its own lookup), so it goes ahead of a Board's queue.
  const renderSession = snapshotRender ? createOfficialPostingRenderSession(
    (url, options) => snapshotRender(url, { ...options, priority: members.length === 1 })) : null;
  try {
    progress();
    if (store) await parallelRows(members.filter(member => !member.bypassCache), async member => {
      const cached = await cachedChatResolution(member.job, store);
      if (cached) settle(member, cached);
    });
    try {
      await findLeads(members.filter(member => !finished.has(member)), 1);
      await findLeads(members.filter(member => !finished.has(member) && !judgeLeadsFor(member, found.get(member) || []).total), 2);
    } finally {
      discoveryPending = false;
      drainHandoffs();
    }
    // Rows with leads were queued as each finder batch returned. Zero-lead
    // rows settle only after their bounded second discovery attempt.
    for (const member of members) queueJudgment(member);
    await Promise.all(judgmentTasks);
    for (const member of members) {
      let result = results.get(member);
      if (TEXT_LEVELS.has(result?.officialPosting?.level) && ['found', 'link-only'].includes(result.officialPosting.outcome)) {
        let description = result.description;
        if (!description && store && result.officialPosting.contentHash) try { description = await store.readText(result.officialPosting.contentHash); } catch { /* The view handles missing/corrupt text. */ }
        if (materiallyDifferent(member.job.snippet || member.job.description, description)) {
          result = addTrail(result, 'material-jd-change'); stats.materialJdChange += 1;
          if (store && result.record && shouldPersistOfficialPostingResult(result, { signal })) try {
            const record = await store.save(member.job, { officialPosting: result.officialPosting, expectedRecord: result.record });
            if (record) result = { ...result, record, officialPosting: record.officialPosting };
          } catch { /* Telemetry and row retain the detected change. */ }
          results.set(member, result);
        }
      }
      countPosting(stats, result?.officialPosting || unresolvedOfficialPosting(member.job, { outcome: 'failed', trail: ['failed'] }).officialPosting, result?.comparison);
    }
    const fetchStats = snapshotSession.telemetry();
    for (const key of FETCH_COUNTERS) stats[key] = count(fetchStats[key]);
    stats.maxPerHostRate = count(fetchStats.maxPerHostRate);
    const byJob = new Map([...results].map(([member, result]) => [member.job, result]));
    const resolved = rows.map(job => { const result = byJob.get(job); return { ...job, postedBy: result?.postedBy,
      officialPosting: normalizeOfficialPosting(result?.officialPosting) || undefined }; });
    if (telemetry && typeof telemetry === 'object') telemetry.officialPosting = stats;
    return { jobs: resolved, telemetry: stats, expiryCandidates: rows.map(() => []) };
  } finally {
    await Promise.allSettled(judgmentTasks);
    readHealth.flush();
    snapshotSession.dispose();
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
    if (!posting || !TEXT_LEVELS.has(posting.level) || !['found', 'link-only'].includes(posting.outcome)) { kept.push(job); continue; }
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
