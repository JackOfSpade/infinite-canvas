import path from 'node:path';
import crypto from 'node:crypto';
import electronPkg from 'electron';
import { callLLMRaw } from './llm.js';
import { createOfficialPostingStore, officialPostingView } from './officialPostingStore.js';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { extractOfficialPostingCandidates } from './officialPostingExtractors.js';
import { officialPostingChunks, resolveOfficialPosting, unresolvedOfficialPosting } from './officialPostingResolver.js';
import { descriptionOverlap } from './officialPostingMatch.js';
import { extractAtsTenant } from './officialSourceHosts.js';
import { normalizeOfficialPosting, officialHttpsUrl, OFFICIAL_POSTING_LEVELS, OFFICIAL_POSTING_OUTCOMES, OFFICIAL_POSTING_TRAIL } from './officialPostingFields.js';
import { buildOfficialPostingResearchRequest, parseOfficialPostingResearchResponse, buildOfficialPostingMatchRequest, validateOfficialPostingMatchResponse } from './officialPostingBridge.js';

export const OFFICIAL_POSTING_HANDOFF_TIMEOUT_MS = 20 * 60 * 1_000;
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
export async function getOfficialPostingView(job, { store, fetch = fetchOfficialPosting, signal, refetch } = {}) {
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
  return officialPostingView(job, { store, refetch: restore });
}

function bridgeError(code) { const error = new Error(code); error.code = code; return error; }
function failureCode(error, signal) {
  if (signal?.aborted && signal.reason?.code === 'bridge-timeout') return 'bridge-timeout';
  if (signal?.aborted) return 'bridge-aborted';
  if (error?.code === 'bridge-timeout') return 'bridge-timeout';
  if (error?.code === 'bridge-unavailable' || /bridge.*(?:unavailable|disabled|not linked)/iu.test(String(error?.message || ''))) return 'bridge-unavailable';
  return 'research-miss';
}

async function cappedHandoff(request, { call, signal, timeoutMs, manualAiRunId, nodeId, hints, now, stats }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || bridgeError('bridge-aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(bridgeError('bridge-timeout')), timeoutMs);
  timer.unref?.();
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
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort);
    const elapsed = Math.max(0, now() - start);
    stats.handoffMs += elapsed;
  }
}

function addTrail(result, code) {
  const posting = result.officialPosting;
  return { ...result, officialPosting: { ...posting,
    trail: [...new Set([...(posting.trail || []), code].filter(item => OFFICIAL_POSTING_TRAIL.includes(item)))].slice(-32) } };
}
function materiallyDifferent(left, right) {
  const a = normalizedText(left); const b = normalizedText(right);
  if (!a || !b || a === b) return false;
  const words = value => value.split(/\s+/u).length;
  return descriptionOverlap(a, b).score < 0.9 || Math.abs(words(a) - words(b)) / Math.max(words(a), words(b)) > 0.15;
}
function telemetryBlock() {
  return { total: 0, levels: Object.fromEntries(OFFICIAL_POSTING_LEVELS.map(level => [level, 0])),
    outcomes: Object.fromEntries(OFFICIAL_POSTING_OUTCOMES.map(outcome => [outcome, 0])), rejections: {},
    handoffs: 0, handoffMs: 0,
    materialJdChange: 0, bridgeTimeout: 0, bridgeUnavailable: 0 };
}

/** Chunks are frozen before cache reads. Free host verification precedes all
 * research; a partial cache hit never changes a handoff's members or hints. */
export async function resolveOfficialPostings(jobs, {
  manualAiRunId, nodeId, signal, callRaw = callLLMRaw, callMatch = callRaw, onProgress, telemetry,
  store, fetch = fetchOfficialPosting, resolve = resolveOfficialPosting, now = Date.now,
  timeoutMs = OFFICIAL_POSTING_HANDOFF_TIMEOUT_MS, bridgeAvailable = true,
} = {}) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const chunks = officialPostingChunks(rows);
  const clock = () => typeof now === 'function' ? Number(now()) : Number(now);
  const stats = telemetryBlock();
  stats.total = rows.length;
  const results = new Map(); const finished = new Set();
  try { store ||= getOfficialPostingStore(); } catch { store = null; }
  const progress = () => { try { onProgress?.({ completed: finished.size, total: rows.length }); } catch { /* Progress cannot fail the search. */ } };
  const settle = member => { finished.add(member); progress(); };
  const safeResolve = async (job, options) => {
    try { return await resolve(job, { store, fetch, signal, now: clock, ...options }); }
    catch (error) { return unresolvedOfficialPosting(job, { outcome: 'failed', trail: [signal?.aborted ? 'bridge-aborted' : error?.code || 'fetch-failed'] }); }
  };
  const persist = async (member, result) => {
    if (!store || signal?.aborted || result.officialPosting.trail?.includes('recent-miss')) return result;
    try {
      const record = await store.save(member.job, { officialPosting: result.officialPosting, description: result.description });
      return { ...result, record, officialPosting: record.officialPosting };
    } catch { return unresolvedOfficialPosting(member.job, { outcome: 'failed', trail: [...(result.officialPosting.trail || []), 'fetch-failed'] }); }
  };
  progress();
  // Do not persist new misses here: they must remain eligible for this run's
  // later batched discovery rather than looking like a prior 24-hour miss.
  for (const chunk of chunks) for (const member of chunk) {
    const result = await safeResolve(member.job, { persistMisses: false });
    results.set(member, result);
    if (VERIFIED_LEVELS.has(result.officialPosting.level)) settle(member);
  }
  for (let batch = 0; batch < chunks.length; batch += 1) {
    const chunk = chunks[batch];
    if (chunk.every(member => VERIFIED_LEVELS.has(results.get(member).officialPosting.level))) continue;
    const pending = chunk.filter(member => !finished.has(member) && !results.get(member).officialPosting.trail?.includes('recent-miss'));
    if (signal?.aborted || !bridgeAvailable) {
      for (const member of pending) {
        const result = addTrail(results.get(member), signal?.aborted ? 'bridge-aborted' : 'bridge-unavailable');
        results.set(member, await persist(member, result)); settle(member);
      }
      for (const member of chunk) if (!finished.has(member)) settle(member);
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
      for (const member of chunk) if (!finished.has(member)) settle(member);
      continue;
    }
    for (const member of pending) {
      if (signal?.aborted) { results.set(member, addTrail(results.get(member), 'bridge-aborted')); settle(member); continue; }
      let matchFailure = null;
      const match = async (job, candidate) => {
        if (matchFailure) throw matchFailure;
        const request = buildOfficialPostingMatchRequest({ scrapedDescription: job.snippet || job.description || '', officialDescription: candidate.description });
        try {
          const raw = await cappedHandoff(request, { call: callMatch, signal, timeoutMs, manualAiRunId, nodeId,
            hints: { itemCount: 1, batch: batch + 1, batchTotal: chunks.length }, now: clock, stats });
          return validateOfficialPostingMatchResponse(raw, { scrapedDescription: job.snippet || job.description || '', officialDescription: candidate.description });
        } catch (error) { matchFailure = bridgeError(failureCode(error, signal)); throw matchFailure; }
      };
      let result = await safeResolve(member.job, { candidateUrls: leads.get(member.id) || [], bypassCache: true, match });
      result = addTrail(result, 'bridge-research');
      results.set(member, await persist(member, result)); settle(member);
    }
    for (const member of chunk) if (!finished.has(member)) settle(member);
  }
  for (const chunk of chunks) for (const member of chunk) {
    let result = results.get(member);
    if (TEXT_LEVELS.has(result.officialPosting.level)) {
      let description = result.description;
      if (!description && store && result.officialPosting.contentHash) try { description = await store.readText(result.officialPosting.contentHash); } catch { /* The view handles missing/corrupt text. */ }
      if (materiallyDifferent(member.job.snippet || member.job.description, description)) {
        result = addTrail(result, 'material-jd-change'); stats.materialJdChange += 1;
        // Only durable verified results reach this branch. Preserve a newer
        // proof if another operation changed the complete record meanwhile.
        if (store && result.record && !signal?.aborted) try {
          const record = await store.save(member.job, { officialPosting: result.officialPosting, expectedRecord: result.record });
          if (record) result = { ...result, record, officialPosting: record.officialPosting };
        } catch { /* Telemetry and the row still retain the detected change. */ }
        results.set(member, result);
      }
    }
    const posting = result.officialPosting;
    stats.levels[posting.level] += 1; stats.outcomes[posting.outcome] += 1;
    for (const code of new Set(posting.trail || [])) {
      if (code === 'bridge-timeout') stats.bridgeTimeout += 1;
      if (code === 'bridge-unavailable') stats.bridgeUnavailable += 1;
      if (['title-mismatch', 'location-mismatch', 'employer-mismatch', 'tenant-unproven', 'poster-tenant', 'salary-mismatch', 'no-anchor', 'invalid-quotes', 'ambiguous', 'closed', 'unreadable', 'oversize', 'unsafe-url', 'unsafe-address', 'fetch-timeout', 'fetch-failed', 'unsupported-content-type', 'invalid-text'].includes(code)) stats.rejections[code] = (stats.rejections[code] || 0) + 1;
    }
  }
  const byJob = new Map([...results].map(([member, result]) => [member.job, result]));
  const resolved = rows.map(job => { const result = byJob.get(job); return { ...job, postedBy: result?.postedBy,
    officialPosting: normalizeOfficialPosting(result?.officialPosting) || undefined }; });
  if (telemetry && typeof telemetry === 'object') telemetry.officialPosting = stats;
  return { jobs: resolved, telemetry: stats };
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
