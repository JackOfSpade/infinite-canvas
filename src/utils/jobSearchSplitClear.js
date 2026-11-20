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
