// Pure helpers for a Job Search hub's clears and Board re-scans: "Clear Career
// Data" (drop identity, keep saved jobs for a Board re-score) and the re-scan
// capability a Board mints before it scrapes a finished Search again.
// This module must not import jobBoardSourceAdmission (which imports it).

import {
  buildJobHubCareerClearPatch,
  hubHasAcceptedInitialDrop,
} from './hubDropEligibility.js';
import { hasLegacyPageScoring, JOB_SCORING_CONTRACT } from './jobScoringContract.js';
import {
  approveCareerImportCompilation,
  beginCareerImportCompilation,
  currentApprovedCareerImportSnapshot,
} from './jobCareerCompilationReceipt.js';
import {
  createJobCareerImportCapability,
  freshJobCareerImportCapability,
  jobCareerImportConsumptionPatch,
} from './jobCareerImportCapability.js';
import { CAREER_CHANGE_RESCORE_THRESHOLD, careerChangeKeepsSavedScores } from './careerTextDifference.js';

export const SAVED_JOBS_RESCORE_VERSION = 1;

const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;

function trimmedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function savedJobCount(data) {
  return Array.isArray(data?.scoredJobs) ? data.scoredJobs.filter(Boolean).length : 0;
}

// A career swap owes every row a new score; a preference re-check does not.
export function savedJobsReevaluationKeepsScores(data) {
  return !hasLegacyPageScoring(data) && !data?.savedJobsRescore;
}

export function hubRetainsSavedJobs(data) {
  return savedJobCount(data) > 0;
}

// A done Search that kept its saved jobs but lost its career files. The
// explicit Clear Career Data stamp is required: an identity-less legacy result
// must keep combining as before, not suddenly read as awaiting new files.
export function isCareerClearedWithSavedJobs(hub) {
  const data = hub?.data || {};
  return hub?.type === 'jobhub'
    && (data.hubState || 'empty') === 'done'
    && hubRetainsSavedJobs(data)
    && !!data.savedJobsCareerClearedAt
    && !hubHasAcceptedInitialDrop(hub);
}

// The durable request a Board consumes to re-score a hub's saved jobs against
// one exact approved career snapshot.
export function buildSavedJobsRescoreMarker({ careerSnapshotId, generation, now = Date.now() } = {}) {
  const snapshotId = trimmedString(careerSnapshotId);
  const normalizedGeneration = trimmedString(generation);
  if (!snapshotId || !SNAPSHOT_ID_PATTERN.test(snapshotId) || !normalizedGeneration) return null;
  return {
    version: SAVED_JOBS_RESCORE_VERSION,
    careerSnapshotId: snapshotId,
    generation: normalizedGeneration,
    requestedAt: now,
  };
}

// The marker only counts while it still names this hub's current generation and
// the approved snapshot that generation compiled.
export function pendingSavedJobsRescore(data) {
  const marker = data?.savedJobsRescore;
  if (!marker && (data?.hubState || 'empty') === 'done' && hasLegacyPageScoring(data)) {
    const approved = currentApprovedCareerImportSnapshot(data, { generation: data.careerImportGeneration });
    if (approved?.careerSnapshotId === data.careerSnapshotId) return {
      version: SAVED_JOBS_RESCORE_VERSION,
      careerSnapshotId: data.careerSnapshotId,
      generation: data.careerImportGeneration,
      reason: 'scoring-evidence-repair',
      scoringContract: JOB_SCORING_CONTRACT,
      scoringOnly: true,
    };
  }
  if (!marker || marker.version !== SAVED_JOBS_RESCORE_VERSION) return null;
  if ((data.hubState || 'empty') !== 'done' || !hubRetainsSavedJobs(data)) return null;
  if (!marker.generation || marker.generation !== data.careerImportGeneration) return null;
  const approved = currentApprovedCareerImportSnapshot(data, { generation: marker.generation });
  if (!approved || approved.careerSnapshotId !== marker.careerSnapshotId) return null;
  return marker;
}

// Clears the marker once its snapshot has been re-scored and, when the hub still
// holds an unspent fresh capability, spends it so the re-score is one-shot.
export function savedJobsRescoreCompletionPatch(data, careerSnapshotId, { nodeId } = {}) {
  const expected = trimmedString(careerSnapshotId);
  if (!expected || data?.savedJobsRescore?.careerSnapshotId !== expected) return null;
  const capability = freshJobCareerImportCapability(data, { nodeId });
  return {
    savedJobsRescore: null,
    ...(capability
      ? jobCareerImportConsumptionPatch({ capability, origin: 'saved-jobs-rescore' })
      : {}),
  };
}

// ── Keeping saved scores when new career data is nearly the same ────────────
// New career files normally owe every saved job a new score. When the new
// version differs by under 10% from the version each saved job was really
// scored with, the scores are kept and no re-score is requested.

export const SAVED_JOBS_RESCORE_SKIP_VERSION = 1;
// The comparison in the app process reads at most this many earlier versions.
export const SAVED_JOBS_RESCORE_MAX_COMPARED_VERSIONS = 20;

function validSnapshotId(value) {
  const id = trimmedString(value);
  return id && SNAPSHOT_ID_PATTERN.test(id) ? id : null;
}

// The career version a saved row was really scored with. A row whose scores
// were kept across a small career change is re-bound to the new version (so
// later searches treat it as current) and remembers its true one here.
export function savedJobScoringSnapshotId(row) {
  return validSnapshotId(row?.scoredCareerSnapshotId) || validSnapshotId(row?.careerSnapshotId);
}

/**
 * The distinct career versions the saved rows were scored with, or null when
 * there are no rows or any row's version is unknown (then nothing can be
 * compared and the re-score stays owed).
 */
export function savedJobScoringSnapshotIds(data) {
  const rows = Array.isArray(data?.scoredJobs) ? data.scoredJobs.filter(Boolean) : [];
  if (rows.length === 0) return null;
  const ids = new Set();
  for (const row of rows) {
    const id = savedJobScoringSnapshotId(row);
    if (!id) return null;
    ids.add(id);
  }
  return [...ids];
}

/** The earlier versions that must be measured against `careerSnapshotId`. */
export function savedJobVersionsToCompare(data, careerSnapshotId) {
  const current = validSnapshotId(careerSnapshotId);
  const ids = savedJobScoringSnapshotIds(data);
  if (!current || !ids) return null;
  const others = ids.filter(id => id !== current);
  return others.length > SAVED_JOBS_RESCORE_MAX_COMPARED_VERSIONS ? null : others;
}

/**
 * Whether the saved jobs keep their scores under new career data.
 * `differences` maps an earlier version's id to its measured difference from
 * the new one (0..1), or null when it could not be read.
 *
 * Kept only when every saved row's true version is the new version itself or
 * measures strictly under 10% different. Anything unknown re-scores.
 */
export function savedJobsRescoreDecision(data, { careerSnapshotId, differences = null } = {}) {
  const others = savedJobVersionsToCompare(data, careerSnapshotId);
  if (!others) return { keepScores: false, reason: 'scoring-version-unknown', maxDifference: null };
  let maxDifference = 0;
  for (const id of others) {
    const difference = differences && typeof differences === 'object' ? differences[id] : null;
    if (!Number.isFinite(difference)) return { keepScores: false, reason: 'difference-unmeasured', maxDifference: null };
    if (difference > maxDifference) maxDifference = difference;
    if (!careerChangeKeepsSavedScores(difference)) {
      return { keepScores: false, reason: 'career-changed', maxDifference };
    }
  }
  return { keepScores: true, reason: others.length === 0 ? 'same-career-data' : 'career-nearly-unchanged', maxDifference };
}

/**
 * The card patch that keeps the saved scores under the new career version:
 * no re-score request, rows re-bound to the new version (each remembering the
 * version it was really scored with, so further small edits are still
 * measured against that), and the one-shot import permission spent the same
 * way a finished re-score spends it.
 */
export function savedJobsRescoreSkipPatch(data, { careerSnapshotId, maxDifference = 0, nodeId, now = Date.now() } = {}) {
  const current = validSnapshotId(careerSnapshotId);
  if (!current) return null;
  const rows = Array.isArray(data?.scoredJobs) ? data.scoredJobs : [];
  let rebound = false;
  const scoredJobs = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const scoredWith = savedJobScoringSnapshotId(row);
    if (!scoredWith) return row;
    // Scored with the new version itself: no separate record is needed.
    const remembered = scoredWith === current ? null : scoredWith;
    if (row.careerSnapshotId === current && (row.scoredCareerSnapshotId ?? null) === remembered) return row;
    rebound = true;
    const { scoredCareerSnapshotId: _earlier, ...rest } = row;
    return remembered
      ? { ...rest, careerSnapshotId: current, scoredCareerSnapshotId: remembered }
      : { ...rest, careerSnapshotId: current };
  });
  const capability = freshJobCareerImportCapability(data, { nodeId });
  return {
    savedJobsRescore: null,
    savedJobsCareerClearedAt: null,
    ...(rebound ? { scoredJobs } : {}),
    scoringCareerSnapshotId: current,
    savedJobsRescoreSkip: {
      version: SAVED_JOBS_RESCORE_SKIP_VERSION,
      careerSnapshotId: current,
      maxDifference: Number.isFinite(maxDifference) ? maxDifference : 0,
      threshold: CAREER_CHANGE_RESCORE_THRESHOLD,
      decidedAt: now,
    },
    ...(capability
      ? jobCareerImportConsumptionPatch({ capability, origin: 'saved-jobs-rescore-skipped' })
      : {}),
  };
}

/**
 * Clear Career Data: the unfinished search run on disk that the Clear should
 * also remove, or null. That is a run owned by this card, started at or
 * before the Clear, whose id is not the one to protect: the run the Clear is
 * already removing (full clear), or the kept jobs' own run (career-only).
 * A run started after the Clear belongs to a newer search.
 */
export function leftoverRunToDiscardOnClear(info, { nodeId, protectedRunId = null, clearedAt = null, startedAt = null } = {}) {
  if (info?.found !== true || !nodeId || info.nodeId !== nodeId) return null;
  const runId = trimmedString(info.runId);
  if (!runId || runId === protectedRunId) return null;
  if (!Number.isFinite(startedAt) || !Number.isFinite(clearedAt) || startedAt > clearedAt) return null;
  return runId;
}

/** The skip record, only while it still names the card's current career data. */
export function currentSavedJobsRescoreSkip(data) {
  const skip = data?.savedJobsRescoreSkip;
  if (!skip || skip.version !== SAVED_JOBS_RESCORE_SKIP_VERSION) return null;
  if (!skip.careerSnapshotId || skip.careerSnapshotId !== data?.careerSnapshotId) return null;
  if (data?.savedJobsRescore) return null;
  return skip;
}

// Clear Career Data: the career-clear patch minus the candidate pool (kept so
// saved jobs can be re-scored) plus the search-plan caches derived from the
// old profile. Results and search settings are untouched.
export function buildJobHubCareerOnlyClearPatch({
  jobAnalysisClearedAt = null,
  jobAnalysisClearedRunId = null,
  now = Date.now(),
} = {}) {
  const patch = buildJobHubCareerClearPatch({ jobAnalysisClearedAt, jobAnalysisClearedRunId });
  delete patch.preferenceCandidatePool;
  return {
    ...patch,
    // Opens this completed hub to a replacement career drop; the approved
    // compile of that drop retires it in favour of `savedJobsRescore`.
    savedJobsCareerClearedAt: now,
    savedJobsRescore: null,
    savedJobsRescoreSkip: null,
    searchBriefPlan: null,
    resolvedRoles: null,
    resolvedRolesMeta: null,
    pinnedTitles: null,
  };
}

// Board re-scan permission for a finished Search. A Board may scrape a card
// again only through a fresh, one-shot career-import capability. This mints one
// against the SAME approved snapshot (no recompile) and touches nothing else:
// the saved jobs stay on the card until the new run replaces them, so a
// cancelled or failed re-scan leaves the earlier result exactly as it was.
// Null when the card has no approved snapshot to bind the capability to.
export function buildJobHubRescanCapabilityPatch(data, {
  nodeId,
  createCapability = createJobCareerImportCapability,
  now = Date.now(),
} = {}) {
  const snapshotId = trimmedString(data?.careerSnapshotId);
  if (!snapshotId || !SNAPSHOT_ID_PATTERN.test(snapshotId) || typeof nodeId !== 'string' || !nodeId) return null;
  const capability = createCapability(nodeId);
  const attemptId = `rescan-${now}`;
  const begun = beginCareerImportCompilation({ generation: capability, attemptId });
  return {
    careerImportGeneration: capability,
    careerImportFreshCapability: capability,
    careerImportConsumption: null,
    careerImportCompilation: approveCareerImportCompilation(begun, {
      generation: capability,
      attemptId,
      careerSnapshotId: snapshotId,
      profileFingerprint: data.resumeFingerprint,
    }),
  };
}
