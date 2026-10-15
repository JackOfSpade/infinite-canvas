// Pure helpers for splitting a Job Search hub's "Clear career data" into two
// independent clears: "Clear Scrape" (drop results, keep career identity) and
// "Clear Career Data" (drop identity, keep saved jobs for a Board re-score).
// This module must not import jobBoardSourceAdmission (which imports it).

import {
  buildJobHubCareerClearPatch,
  hubHasAcceptedInitialDrop,
} from './hubDropEligibility.js';
import { normalizeJobAnalysisClearRunId } from './jobAnalysisRecovery.js';
import {
  approveCareerImportCompilation,
  beginCareerImportCompilation,
  careerResumeInputPaths,
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

export function jobHubClearAvailability(hub) {
  const data = hub?.data || {};
  return {
    savedJobCount: savedJobCount(data),
    careerClearedWithJobs: isCareerClearedWithSavedJobs(hub),
    canClearScrape: data.hubState === 'done' && hubRetainsSavedJobs(data),
    canClearCareer: hubHasAcceptedInitialDrop(hub),
  };
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

// Clear Scrape: reset every scrape result but keep career identity and
// settings, and re-mint Board scan permission against the SAME approved
// snapshot so the next Board run can start a fresh scan without a re-import.
export function buildJobHubScrapeClearPatch(data, {
  nodeId,
  jobAnalysisClearedAt = null,
  jobAnalysisClearedRunId = null,
  materializedSearchHistory = {},
  createCapability = createJobCareerImportCapability,
  now = Date.now(),
} = {}) {
  const patch = {
    hubState: 'empty',
    scoredJobs: null,
    finalSourceCounts: {},
    resultCount: 0,
    totalScoredCount: 0,
    scrapedCount: 0,
    gatheredCount: 0,
    scoreThreshold: 0,
    jobRunId: null,
    jobCount: null,
    scoreRangeMin: null,
    scoreRangeMax: null,
    aiSkipped: false,
    collectionOnly: false,
    testMode: false,
    resultDisposition: null,
    searchWindow: null,
    pendingJobs: null,
    pendingTargetRole: null,
    scrapeWarnings: [],
    collectionScopeCaveats: [],
    preferenceMatchedCount: null,
    preferenceFilteredCount: null,
    preferenceEvaluation: null,
    preferenceCandidatePool: null,
    preferenceCareerSnapshotId: null,
    scoringCareerSnapshotId: null,
    savedJobsRescore: null,
    savedJobsCareerClearedAt: null,
    errorMessage: null,
    rerunOutcome: null,
    rerunNotice: null,
    reanalysisNotice: null,
    testModeNote: null,
    queuedModuleRun: null,
    analysisOperation: null,
    retryOperation: null,
    retryOperationFor: null,
    pendingCollectionCompletion: null,
    partialCollectionRunId: null,
    terminalFinalizationRecovery: null,
    manualAiResume: null,
    dragHover: null,
    jobAnalysisClearedAt,
    jobAnalysisClearedRunId: normalizeJobAnalysisClearRunId(jobAnalysisClearedRunId),
    // Retained scan-date history; spread last so it is never dropped.
    ...materializedSearchHistory,
  };

  // Keep a legacy single file path under the modern key so an empty hub with a
  // stray `filePath` can never look like an autostart input.
  if (typeof data?.filePath === 'string' && data.filePath) {
    patch.filePath = null;
    patch.careerFilePaths = careerResumeInputPaths(data);
  }

  const snapshotId = trimmedString(data?.careerSnapshotId);
  if (snapshotId && SNAPSHOT_ID_PATTERN.test(snapshotId) && typeof nodeId === 'string' && nodeId) {
    const capability = createCapability(nodeId);
    const attemptId = `rescan-${now}`;
    const begun = beginCareerImportCompilation({ generation: capability, attemptId });
    patch.careerImportGeneration = capability;
    patch.careerImportFreshCapability = capability;
    patch.careerImportConsumption = null;
    patch.careerImportCompilation = approveCareerImportCompilation(begun, {
      generation: capability,
      attemptId,
      careerSnapshotId: snapshotId,
      profileFingerprint: data.resumeFingerprint,
    });
  }
  return patch;
}
