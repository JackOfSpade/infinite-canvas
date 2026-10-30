import { normalizeOfficialPosting, officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';
import { officialPostingNeedsRefresh } from './officialPostingDisplay.js';
import { officialPostingPreparationSourceKey, projectOfficialPostingGenerationJob } from './officialPostingPreparation.js';

const MAX_REFRESH_ENTRIES = 128;
const MAX_REFRESH_BATCH_BYTES = 15 * 1024 * 1024;
const MAX_REFRESH_JOB_BYTES = 512 * 1024;
const failure = (message, code = 'JOB_OFFICIAL_REFRESH_INVALID') => Object.assign(new Error(message), { code });
const sourceKey = job => officialPostingPreparationSourceKey(projectOfficialPostingGenerationJob(job));
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const metadataKey = value => JSON.stringify(canonical(value));
const postedByValid = value => value === undefined || typeof value === 'string' && value.length <= 500
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Counts lookup attempts, independently of whether a live card still accepts
 * its result. An interrupted recheck of a verified posting remains incomplete. */
export function summarizeBoardOfficialPostingChecks(jobs) {
  const counts = { checked: 0, verified: 0, notFound: 0, ambiguous: 0, closed: 0, retryable: 0 };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    counts.checked++;
    const status = officialPostingLookupStatus(job?.officialPosting);
    if (status.retryable) counts.retryable++;
    else if (status.state === 'verified') counts.verified++;
    else if (status.state === 'not-found') counts.notFound++;
    else if (status.state === 'ambiguous') counts.ambiguous++;
    else if (status.state === 'closed') counts.closed++;
  }
  return counts;
}

/** The caller separately fences operation ownership, deletion and Board scope.
 * A live card edit or another lookup's settlement makes its old result stale. */
export function boardOfficialPostingRefreshCardMatches(node, snapshot, boardId) {
  return node?.type === 'jobcard' && node.id === snapshot?.id && node.data?.hubId === boardId && !node.data.locked
    && snapshot.key === sourceKey(node.data)
    && snapshot.posting === JSON.stringify(node.data.officialPosting ?? null)
    && (!Object.hasOwn(snapshot, 'postedBy') || snapshot.postedBy === node.data.postedBy);
}

/** Carry a current lookup or retry hint for the exact final card source.
 * Source runs remain immutable; only the host may reuse lookup authority.
 * Conflicting cards receive a transient retry marker, so a completed source
 * cache entry cannot silently erase their disagreement or failed recheck. */
export function carryBoardOfficialPostingResults(jobs, cards) {
  const bySource = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card?.type !== 'jobcard' || !card.data || !postedByValid(card.data.postedBy)) continue;
    const posting = normalizeOfficialPosting(card.data.officialPosting);
    if (!posting || officialPostingNeedsRefresh(card.data) && !officialPostingLookupStatus(posting).retryable) continue;
    const metadata = { officialPosting: posting, postedBy: card.data.postedBy };
    const key = sourceKey(card.data);
    const previous = bySource.get(key);
    if (!previous) bySource.set(key, { metadata, fingerprint: metadataKey(metadata), conflicted: false });
    else if (previous.fingerprint !== metadataKey(metadata)) previous.conflicted = true;
  }
  return (Array.isArray(jobs) ? jobs : []).map(job => {
    const saved = bySource.get(sourceKey(job));
    if (!saved) return job;
    if (saved.conflicted) return { ...job,
      officialPosting: { level: 'L5', outcome: 'failed', employer: '', trail: ['failed'] } };
    return { ...job, ...saved.metadata };
  });
}

/** Refresh lookup metadata without deduplicating, rescoring or changing any
 * source row. Results are returned atomically after every batch is validated. */
export async function refreshBoardOfficialPostingJobs(jobs, {
  nodeId, manualAiRunId, refresh, cancelled = () => false, force = false, onProgress, cardIds,
} = {}) {
  const active = () => {
    if (cancelled()) throw failure('Official posting refresh was cancelled.', 'JOB_OFFICIAL_REFRESH_CANCELLED');
  };
  active();
  const rows = Array.isArray(jobs) ? jobs : [];
  if (cardIds !== undefined && (!Array.isArray(cardIds) || cardIds.length !== rows.length
    || cardIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,300}$/u.test(id))
    || new Set(cardIds).size !== cardIds.length)) throw failure('Official posting refresh needs one unique card identifier per row.');
  const rowId = index => cardIds?.[index] ?? `official-row-${index}`;
  const pending = rows.flatMap((job, index) => force || officialPostingNeedsRefresh(job) ? [{ job, index }] : []);
  const output = rows.slice();
  let refreshed = 0;
  const progress = () => {
    try { onProgress?.({ completed: refreshed, total: pending.length }); } catch { /* Progress cannot fail a lookup. */ }
  };
  progress();
  active();
  if (!pending.length) return { jobs: output, refreshed };
  if (typeof refresh !== 'function') throw failure('Official posting refresh is unavailable.', 'JOB_OFFICIAL_REFRESH_UNAVAILABLE');
  let offset = 0;
  while (offset < pending.length) {
    active();
    const batch = []; const entries = [];
    let bytes = 0;
    while (offset < pending.length && batch.length < MAX_REFRESH_ENTRIES) {
      const member = pending[offset];
      const projected = structuredClone(projectOfficialPostingGenerationJob(member.job));
      const size = new TextEncoder().encode(JSON.stringify(projected)).byteLength;
      if (size > MAX_REFRESH_JOB_BYTES) throw failure('An official posting source exceeds the refresh size limit.');
      if (batch.length && bytes + size > MAX_REFRESH_BATCH_BYTES) break;
      batch.push(member); entries.push({ cardId: rowId(member.index), job: projected });
      bytes += size; offset++;
    }
    let response;
    try { response = await refresh({ nodeId, manualAiRunId, entries }); }
    catch (error) {
      active();
      if (error?.name === 'AbortError' || ['bridge-aborted', 'APP_QUIT_PAUSED', 'JOB_OFFICIAL_REFRESH_CANCELLED'].includes(error?.code)) {
        throw failure('Official posting refresh was cancelled.', 'JOB_OFFICIAL_REFRESH_CANCELLED');
      }
      throw error;
    }
    active();
    if (response?.cancelled || response?.pausedForQuit || response?.errorCode === 'APP_QUIT_PAUSED') {
      throw failure('Official posting refresh was cancelled.', 'JOB_OFFICIAL_REFRESH_CANCELLED');
    }
    if (response?.success !== true) throw failure(response?.error || 'Official posting refresh failed.',
      response?.errorCode || 'JOB_OFFICIAL_REFRESH_FAILED');
    if (!Array.isArray(response.entries) || response.entries.length !== batch.length) {
      throw failure('Official posting refresh returned incomplete results.');
    }
    const expected = new Map(batch.map(member => [rowId(member.index), member]));
    const seen = new Set();
    const validated = response.entries.map(result => {
      const member = expected.get(result?.cardId);
      const posting = normalizeOfficialPosting(result?.officialPosting);
      if (!member || seen.has(result.cardId) || !posting || !postedByValid(result.postedBy)) {
        throw failure('Official posting refresh returned invalid results.');
      }
      seen.add(result.cardId);
      return { index: member.index, officialPosting: posting, postedBy: result.postedBy };
    });
    active();
    for (const result of validated) output[result.index] = { ...rows[result.index],
      officialPosting: result.officialPosting, postedBy: result.postedBy };
    refreshed += validated.length;
    progress();
    active();
  }
  return { jobs: output, refreshed };
}
