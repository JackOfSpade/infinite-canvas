/**
 * The Job Board side's link to the saved listing streams.
 *
 * A Board calls `board-intake-step` again and again while any stream it reads
 * has unread records; each call takes a small batch (boardIntake.js), so the
 * first cards appear while a long scrape is still running and an interrupted
 * step redoes little. Nothing here starts, pauses or steers a search.
 */
import { filterAppliedListings } from '../../../src/utils/applicationBundleIdentity.js';
import { sourceJobKey } from '../../../src/utils/jobIdentity.js';
import { filterNonEnglishJobs } from '../../../src/utils/jobLanguage.js';
import { logger } from '../../logger.js';
import { readJobListingStream } from '../jobListingStream.js';
import { evaluateJobPreferences, screenJobRolesByTitle } from '../jobPreferences.js';
import { getJobRoleScreenVerdictStore } from '../jobRoleScreenVerdicts.js';
import { appendJobsHistory, dedupAgainstHistory, loadJobsHistory } from '../jobsHistory.js';
import { callLLMRaw, callLLMText } from '../llm.js';
import { loadAppliedListingKeys } from '../localAiApplication.js';
import { jobListingStreamRoot } from '../sharedAppData.js';
import { runBoardIntakeStep, runBoardReevaluationStep } from './boardIntake.js';
import { appendBoardListingRecords, boardListingStorePath, compactBoardListingStore, loadBoardListingState, removeBoardListingStore, summarizeBoardListingState } from './boardListingStore.js';
import { UNSCORED_FALLBACK_SCORE, officialPostingConsumerJobs, restoreOfficialPostingConsumerIdentity, scoreRowsOnCareerRecord } from './scoring.js';
import { hasResolvedJobDescription } from './sourceRules.js';

/** Which listings a re-evaluation takes: only those never scored, or every kept one. */
const REEVALUATION_SELECTORS = Object.freeze({
  unscored: row => row.state === 'unscored',
  all: row => ['scored', 'filtered', 'unscored'].includes(row.state),
});

function normalizedIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(id => typeof id === 'string' && id))];
}

export function registerBoardIntakeHandlers(ctx) {
  const { handleSafe, resolvePinnedScoringInputForHandler, runScoreBatch, runGapReview } = ctx;

  const intakeDeps = ({ canvasFilePath, storePath, nodeId, signal }) => ({
    readStream: (streamId, position, options) => readJobListingStream(jobListingStreamRoot(), streamId, position, options),
    // One load per step: what was already shown on a Board, and what was applied to.
    loadSeen: async () => {
      const history = await loadJobsHistory(canvasFilePath);
      let appliedKeys = new Set();
      try {
        appliedKeys = await loadAppliedListingKeys(canvasFilePath);
      } catch (error) {
        logger.warn(`[BoardIntake][${nodeId}] applied-listing check unavailable: ${error?.message || error}`);
      }
      return {
        dropSeen(jobs) {
          const afterHistory = new Set(dedupAgainstHistory(jobs, history).kept);
          const notSeen = jobs.filter(job => afterHistory.has(job));
          const afterApplied = new Set(filterAppliedListings(notSeen, appliedKeys).kept);
          return {
            seen: jobs.filter(job => !afterHistory.has(job)),
            applied: notSeen.filter(job => !afterApplied.has(job)),
          };
        },
      };
    },
    hasDescription: hasResolvedJobDescription,
    filterLanguage: jobs => filterNonEnglishJobs(jobs).jobs,
    // Judged by the preferences of the search run that found the listing.
    evaluate: async ({ jobs, run }) => {
      const plan = run?.jobPreferencePlan || null;
      const titles = Array.isArray(plan?.titles) ? plan.titles.filter(title => typeof title === 'string' && title.trim()) : [];
      const indexByKey = new Map(jobs.map((job, index) => [sourceJobKey(job), index]));
      let pool = jobs;
      // Listings the search's own per-page title check did not judge.
      const unscreened = [];
      pool.forEach((job, at) => { if (!job?.roleScreen) unscreened.push({ job, at }); });
      if (titles.length > 0 && unscreened.length > 0) {
        const screen = await screenJobRolesByTitle({
          jobs: await officialPostingConsumerJobs(unscreened.map(entry => entry.job)),
          titles, signal, callText: callLLMText, verdictStore: getJobRoleScreenVerdictStore(), meta: {},
        });
        const next = pool.slice();
        const wrongRole = new Set();
        unscreened.forEach((entry, index) => {
          const verdict = screen?.verdictsByIndex?.[index] || { outcome: 'unclear', reason: '' };
          next[entry.at] = { ...entry.job, roleScreen: verdict };
          if (verdict.outcome === 'mismatch') wrongRole.add(entry.at);
        });
        pool = next.filter((_job, at) => !wrongRole.has(at));
      }
      if (pool.length === 0) return { accepted: [], filtered: [] };
      const careerSnapshotId = typeof run?.careerSnapshotId === 'string' ? run.careerSnapshotId : null;
      const pinned = careerSnapshotId ? await resolvePinnedScoringInputForHandler({ careerSnapshotId }) : null;
      const result = await evaluateJobPreferences({
        jobs: await officialPostingConsumerJobs(pool),
        identityJob: restoreOfficialPostingConsumerIdentity,
        jobPreferences: typeof run?.jobPreferences === 'string' ? run.jobPreferences : '',
        preferencePlan: plan,
        profile: pinned?.profile || null,
        careerData: pinned?.careerData || '',
        signal,
        callText: callLLMText,
        callRaw: callLLMRaw,
        deferCompanyResearch: true,
        meta: {},
      });
      const place = rows => (Array.isArray(rows) ? rows : []).map(restoreOfficialPostingConsumerIdentity)
        .map(job => ({ index: indexByKey.get(sourceJobKey(job)), job }))
        .filter(item => Number.isSafeInteger(item.index));
      return { accepted: place(result?.acceptedJobs), filtered: place(result?.filteredJobs) };
    },
    score: async ({ jobs, careerSnapshotId }) => {
      const { scored, sources, failed } = await scoreRowsOnCareerRecord({
        jobs, careerSnapshotId, nodeId, signal, callScore: runScoreBatch, runGapReview,
        readPinned: resolvePinnedScoringInputForHandler, attemptKind: 'board-intake',
      });
      // Returned in the order sent; a row the scorer could not settle comes back marked unscored.
      const scoredByJob = new Map(sources.map((job, index) => [job, scored[index]]));
      const failedSet = new Set(failed);
      return jobs.map((job) => {
        const row = scoredByJob.get(job);
        if (row && !failedSet.has(job)) return { ...row, careerSnapshotId };
        return { ...job, unscored: true, matchScore: UNSCORED_FALLBACK_SCORE };
      });
    },
    save: records => appendBoardListingRecords(storePath, records, { now: Date.now() }),
  });

  // Take the next batch from the Board's streams (or judge again listings it
  // already holds, when `reevaluate` names which).
  handleSafe('board-intake-step', async (_event, { canvasFilePath, nodeId, streamIds, deletedKeys = [], careerSnapshotId = null, reevaluate = null } = {}, signal) => {
    const storePath = boardListingStorePath(canvasFilePath, nodeId);
    if (!storePath) return { success: false, error: 'Save this canvas before the Job Board can take listings.' };
    const deps = intakeDeps({ canvasFilePath, storePath, nodeId, signal });
    const state = await loadBoardListingState(storePath);
    const boardCareer = typeof careerSnapshotId === 'string' && careerSnapshotId ? careerSnapshotId : null;
    let result;
    if (reevaluate && REEVALUATION_SELECTORS[reevaluate]) {
      result = await runBoardReevaluationStep({ state, select: REEVALUATION_SELECTORS[reevaluate], deletedKeys, careerSnapshotId: boardCareer, deps });
    } else {
      result = await runBoardIntakeStep({ streamIds: normalizedIds(streamIds), state, deletedKeys, careerSnapshotId: boardCareer, deps });
    }
    await compactBoardListingStore(storePath, { now: Date.now() }).catch(() => false);
    return { success: true, ...result, summary: summarizeBoardListingState(await loadBoardListingState(storePath)) };
  });

  // What the Board holds now: the scored listings its cards are built from,
  // the listings preferences ruled out, the latest status of each stream.
  handleSafe('board-intake-state', async (_event, { canvasFilePath, nodeId, includeRows = false } = {}) => {
    const storePath = boardListingStorePath(canvasFilePath, nodeId);
    if (!storePath) return { success: true, summary: summarizeBoardListingState(null), statuses: {}, rows: [], filtered: [] };
    const state = await loadBoardListingState(storePath);
    const withOrigin = row => ({ ...row.job, originHubId: row.streamId, listingStreamKey: row.key });
    const rows = includeRows ? [...state.rows.values()].filter(row => row.state === 'scored' && row.job).map(withOrigin) : [];
    const filtered = includeRows ? [...state.rows.values()].filter(row => row.state === 'filtered' && row.job).map(withOrigin) : [];
    return {
      success: true,
      summary: summarizeBoardListingState(state),
      statuses: Object.fromEntries(state.statuses),
      positions: Object.fromEntries(state.positions),
      rows,
      filtered,
    };
  });

  // Listings whose cards a Board has just put on screen are recorded as seen,
  // so no later Board shows them again. The Board names each by its stream
  // key; only a listing this Board's own record holds as scored is written,
  // so a stale or mistaken caller cannot mark unseen listings as seen.
  handleSafe('record-board-shown-listings', async (_event, { canvasFilePath, nodeId, shown = [] } = {}) => {
    const storePath = boardListingStorePath(canvasFilePath, nodeId);
    if (!storePath) return { success: false, error: 'Save this canvas before listings can be recorded as seen.' };
    const state = await loadBoardListingState(storePath);
    const text = value => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 2000) : '');
    const rows = [];
    let refused = 0;
    for (const entry of Array.isArray(shown) ? shown.slice(0, 10000) : []) {
      if (state.rows.get(entry?.key)?.state !== 'scored') { refused += 1; continue; }
      for (const row of Array.isArray(entry.rows) ? entry.rows.slice(0, 50) : []) {
        const next = { source: text(row?.source), company: text(row?.company), title: text(row?.title), location: text(row?.location), url: text(row?.url) };
        if (next.title || next.url) rows.push(next);
      }
    }
    const result = rows.length > 0 ? await appendJobsHistory(canvasFilePath, rows) : { written: 0, pruned: 0 };
    if (refused > 0) logger.warn(`[BoardIntake][${nodeId}] ${refused} shown listing(s) were not in this Board's record and were not marked seen`);
    return { success: true, written: Number(result?.written) || 0, refused };
  });

  // The Board stopped reading a stream (its Search was disconnected), or the
  // Board itself was deleted.
  handleSafe('board-intake-forget', async (_event, { canvasFilePath, nodeId, streamId = null, removeBoard = false } = {}) => {
    const storePath = boardListingStorePath(canvasFilePath, nodeId);
    if (!storePath) return { success: true };
    if (removeBoard === true) await removeBoardListingStore(storePath);
    else if (typeof streamId === 'string' && streamId) await appendBoardListingRecords(storePath, [{ t: 'forget', streamId }], { now: Date.now() });
    return { success: true };
  });
}
