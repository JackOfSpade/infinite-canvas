import { handleSafe } from './ipcUtils.js';
import { getHandoffBridgeStatus } from './handoffBridge/index.js';
import { bridgeLinked } from './handoffBridge/bridgeAvailability.js';
import { getOfficialPostingStore, resolveOfficialPostings } from './officialPostingService.js';
import { createOfficialPostingFetchSession } from './officialPostingFetchSession.js';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { officialPostingRecordMatchesScrapedIdentity } from './officialPostingStore.js';
import { RESEARCH_UNSETTLED_TRAIL, boundedOfficialPostingTrail, normalizeOfficialPosting, officialHttpsUrl, officialPostingLookupStatus } from './officialPostingFields.js';
import { officialPostingSemanticProofMatches } from './officialPostingSemantic.js';
import { officialPostingSemanticInputHash } from './officialPostingSemantic.js';
import { strictEmployerEqual } from './officialSourceHosts.js';
import { projectOfficialPostingSourceFields } from './officialPostingSourceProjection.js';
import { canonicalLeadUrl } from './officialPostingMatch.js';

/** A failed recheck keeps the verified record and its proof codes, but not that record's own unsettled codes: the trail is
 * de-duplicated, so they would shadow this recheck's codes and the status would report the earlier run's reason as the latest. */
export function retainedRecheckTrail(prior, posting) {
  const trail = boundedOfficialPostingTrail([...(prior?.trail || []).filter(code => code !== 'reverify-failed'
    && !RESEARCH_UNSETTLED_TRAIL.includes(code)), ...(posting?.trail || []), 'reverify-failed']);
  if (!trail.includes('reverify-failed')) trail[trail.length - 1] = 'reverify-failed';
  return trail;
}

export const OFFICIAL_POSTING_REFRESH_MAX_ENTRIES = 128;
const MAX_JOB_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_.:-]{1,300}$/u;
const officialLevels = new Set(['L1', 'L2', 'L3', 'L4']);
const error = (message, code) => Object.assign(new Error(message), { code });
function active(signal) {
  if (signal?.aborted) throw signal.reason || error('Official posting refresh was cancelled.', 'bridge-aborted');
}

function serializedBytes(value) {
  const seen = new Set();
  const visit = (item, depth = 0) => {
    if (depth > 16) throw new TypeError('Official posting refresh input is nested too deeply.');
    if (item === undefined || item === null || typeof item === 'string' || typeof item === 'boolean'
      || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)
      || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) {
      throw new TypeError('Official posting refresh input must be serializable data.');
    }
    seen.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  };
  visit(value);
  return Buffer.byteLength(JSON.stringify(value));
}

export function validateOfficialPostingRefreshArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !['nodeId', 'manualAiRunId', 'entries', 'force'].includes(key))
    || args.force !== undefined && typeof args.force !== 'boolean'
    || !ID.test(args.nodeId || '') || typeof args.nodeId !== 'string'
    || typeof args.manualAiRunId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/u.test(args.manualAiRunId)
    || !Array.isArray(args.entries) || !args.entries.length || args.entries.length > OFFICIAL_POSTING_REFRESH_MAX_ENTRIES) {
    throw new TypeError('Invalid official posting refresh request.');
  }
  const ids = new Set();
  let bytes = 0;
  for (const entry of args.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['cardId', 'job'].includes(key))
      || typeof entry.cardId !== 'string' || !ID.test(entry.cardId) || ids.has(entry.cardId)
      || !entry.job || typeof entry.job !== 'object' || Array.isArray(entry.job)) {
      throw new TypeError('Official posting refresh needs unique card identifiers and job objects.');
    }
    ids.add(entry.cardId);
    const size = serializedBytes(entry.job);
    if (size > MAX_JOB_BYTES || (bytes += size) > MAX_REQUEST_BYTES) throw new TypeError('Official posting refresh input exceeds its size limit.');
  }
}

/** A refresh publishes only lookup fields. It never creates a Generate receipt
 * or passes its rows through Board deduplication, scoring or retirement. */
export async function refreshOfficialPostingEntries(args, {
  projectJob = value => ({ ...value }), resolve = resolveOfficialPostings, store,
  fetch = fetchOfficialPosting, bridgeStatus = getHandoffBridgeStatus, signal, onProgress,
  callRaw, callMatch, now = Date.now,
} = {}) {
  validateOfficialPostingRefreshArgs(args);
  active(signal);
  let linked = false;
  try { linked = bridgeLinked(await bridgeStatus()); } catch { /* Missing research cannot silently become a completed miss. */ }
  active(signal);
  if (!linked) throw error('Connect ChatGPT research before refreshing official postings.', 'OFFICIAL_POSTING_RESEARCH_UNAVAILABLE');
  store ||= getOfficialPostingStore();
  const jobs = args.entries.map(({ job }) => {
    const projected = structuredClone(projectJob(job));
    if (!projected || typeof projected !== 'object' || Array.isArray(projected)) throw new TypeError('Invalid official posting job projection.');
    // The application projection intentionally omits some source facts. Keep
    // their bounded original values for semantic comparison during refresh.
    Object.assign(projected, projectOfficialPostingSourceFields(job));
    delete projected.officialPosting; delete projected.postedBy; delete projected.applyUrl;
    delete projected.listingAudit; delete projected.listingCheck;
    if (typeof projected.title !== 'string' || !projected.title.trim()) throw new TypeError('Official posting refresh needs a job title.');
    return projected;
  });
  const priorOfficialRecords = [];
  const candidateUrlsByRow = [];
  // Store reads retain exact input order, including separate cards for the
  // same source. A renderer-provided official URL is a lead, never authority.
  for (const [index, job] of jobs.entries()) {
    active(signal);
    const found = await store.find(job);
    const record = found && officialPostingRecordMatchesScrapedIdentity(job, found) ? found : null;
    priorOfficialRecords.push(record);
    const cardPosting = normalizeOfficialPosting(args.entries[index].job.officialPosting);
    candidateUrlsByRow.push([...new Set([record?.officialPosting?.sourceUrl, record?.officialPosting?.officialApplyUrl,
      cardPosting?.sourceUrl, cardPosting?.officialApplyUrl].map(officialHttpsUrl).filter(Boolean))]);
  }
  active(signal);
  // ChatGPT reads the pages in production; a host fetch session exists only for an injected crawl fetcher.
  const session = fetch === fetchOfficialPosting ? null : createOfficialPostingFetchSession({ fetch, signal });
  const progress = value => {
    if (signal?.aborted) return;
    const completed = Math.min(jobs.length, Math.max(0, Math.floor(Number(value?.completed) || 0)));
    try { onProgress?.({ nodeId: args.nodeId, manualAiRunId: args.manualAiRunId, completed, total: jobs.length }); } catch { /* UI progress cannot fail research. */ }
  };
  try {
    progress({ completed: 0 });
    const resolved = await resolve(jobs, { store, fetch, ...(session ? { fetchSession: session } : {}), signal, now,
      nodeId: args.nodeId, manualAiRunId: args.manualAiRunId, semanticMatching: true, bypassCache: args.force !== false,
      bypassCacheByRow: args.entries.map(({ job }) => {
        const posting = normalizeOfficialPosting(job.officialPosting);
        return Boolean(posting && officialPostingLookupStatus(posting).retryable);
      }),
      bridgeAvailable: true, bridgeStatus, priorOfficialRecords, candidateUrlsByRow, onProgress: progress,
      ...(callRaw ? { callRaw } : {}), ...(callMatch ? { callMatch } : {}) });
    active(signal);
    if (!Array.isArray(resolved?.jobs) || resolved.jobs.length !== jobs.length) {
      throw error('Official posting refresh returned incomplete results.', 'OFFICIAL_POSTING_REFRESH_INCOMPLETE');
    }
    const entries = resolved.jobs.map((row, index) => {
      const posting = normalizeOfficialPosting(row?.officialPosting);
      if (!posting || officialPostingSemanticInputHash(row) !== officialPostingSemanticInputHash(jobs[index])
        || (!officialPostingLookupStatus(posting).retryable || officialLevels.has(posting.level))
          && !officialPostingSemanticProofMatches(jobs[index], posting)) {
        throw error('Official posting refresh returned an invalid match.', 'OFFICIAL_POSTING_REFRESH_INVALID');
      }
      const prior = normalizeOfficialPosting(priorOfficialRecords[index]?.officialPosting);
      const retain = prior && officialLevels.has(prior.level) && ['found', 'link-only'].includes(prior.outcome)
        && posting.outcome !== 'closed' && officialPostingLookupStatus(posting).retryable;
      const trail = retain ? retainedRecheckTrail(prior, posting) : null;
      // Failures describe one run: the record carries this recheck's, never an earlier recheck's.
      const { fetchFailures: _earlierFailures, alternatives: _earlierAlternatives, ...priorRecord } = prior || {};
      // Only the judges' own citations ride along on a kept verification, never the generic lead list.
      const alternatives = (posting.alternatives || []).filter(item => item.title.startsWith('Unconfirmed')
        && canonicalLeadUrl(item.url) !== canonicalLeadUrl(prior?.sourceUrl));
      const officialPosting = retain ? { ...priorRecord, trail,
        ...(alternatives.length ? { alternatives } : {}),
        ...(posting.fetchFailures?.length ? { fetchFailures: posting.fetchFailures } : {}) } : posting;
      return { cardId: args.entries[index].cardId, officialPosting,
        postedBy: officialLevels.has(officialPosting.level)
          ? strictEmployerEqual(officialPosting.employer, jobs[index].company) ? '' : jobs[index].company
          : row.postedBy || '' };
    });
    progress({ completed: jobs.length });
    return { entries, telemetry: resolved.telemetry || null };
  } finally { session?.dispose(); }
}

export function registerOfficialPostingRefreshHandler({ projectJob, ...dependencies } = {}) {
  if (typeof projectJob !== 'function') throw new TypeError('Official posting refresh needs the host job projection.');
  handleSafe('refresh-official-postings', (event, args, signal) => refreshOfficialPostingEntries(args, {
    ...dependencies, projectJob, signal,
    onProgress: progress => { if (!event.sender.isDestroyed()) event.sender.send('official-posting-refresh-progress', progress); },
  }), { validateArgs: validateOfficialPostingRefreshArgs, additionalNodeIds: args => args.entries.map(entry => entry.cardId),
    maxAdditionalNodeIds: OFFICIAL_POSTING_REFRESH_MAX_ENTRIES, reportCancellation: true });
}
