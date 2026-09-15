import { normalizeJobAnalysisClearRunId } from './jobAnalysisRecovery.js';

const ACTIVE_INPUT_STATES = new Set([
  'analyzing',
  'parsing',
  'querying',
  'researching',
  'scoring',
  'searching',
]);

function hasItems(value) {
  return Array.isArray(value) && value.some(Boolean);
}

// The jobhub fields that, on their own, mean "this hub already took its career
// files". Exported so the READER below and the tests that guard it against
// drifting from buildJobHubCareerClearPatch (the WRITER) share one list instead
// of two hand-maintained copies. `inputLocked` is deliberately NOT here: it is
// hub-type-agnostic and handled ahead of every per-type branch.
export const JOBHUB_CAREER_IDENTITY_FIELDS = ['careerData', 'resumeProfile', 'filePath', 'filePaths', 'careerFilePaths'];

// Arrays count only when they hold something; scalars count on truthiness.
function hasIdentityValue(value) {
  return Array.isArray(value) ? hasItems(value) : !!value;
}

export function hubHasAcceptedInitialDrop(hub) {
  const data = hub?.data || {};
  if (data.inputLocked) return true;

  if (hub?.type === 'jobhub') {
    return JOBHUB_CAREER_IDENTITY_FIELDS.some(field => hasIdentityValue(data[field]));
  }

  if (hub?.type === 'sellhub') {
    return !!(data.product || hasItems(data.imagePaths));
  }

  return false;
}

// WRITER dual of hubHasAcceptedInitialDrop's jobhub reader field set — i.e.
// inputLocked + JOBHUB_CAREER_IDENTITY_FIELDS — plus the caches derived from
// those files. Applied as a data patch, it must make hubHasAcceptedInitialDrop
// return false again so the hub re-opens for a fresh initial drop.
// migrateStaleJobHubInputLock (serializationUtils.js) checks the same identity
// fields, so keep all three in sync. The keys stay spelled out literally here
// because this list IS the writer contract (a test asserts it covers every
// exported identity field); deriving it would make it agree with the reader by
// construction and stop catching drift.
//   • First 9 keys — the drop-lock identity itself.
//   • achievements / achievementsMining — the mined accomplishment ledger and
//     its in-flight fencing marker. NEITHER is fingerprint-keyed (JobCardNode's
//     mineAllowed is just `!cachedAchievements && !markerFresh`), so a surviving
//     ledger would silently write new résumés from the OLD files' figures.
//   • queries / queryCacheKey / queryModel / queryCount — LLM search queries
//     generated from the old profile.
//   • jobPreferencePlan / jobPreferencesInterpretation — the AI's reading of
//     the retained raw Job Preferences against the old profile. The user text
//     stays, but the next profile must receive a fresh interpretation.
//   • canonicalLocation — inferred FROM the profile whenever preferredLocation
//     is blank.
// Deliberately NOT cleared: targetRole, jobPreferences, preferredLocation, searchLocation,
// remoteResidences, maxAgeDays, collectionLimits, enabledSourceIds — the search settings the
// user is keeping when they swap career files.
export function buildJobHubCareerClearPatch({ jobAnalysisClearedAt = null, jobAnalysisClearedRunId = null } = {}) {
  return {
    inputLocked: false,
    careerImportGeneration: null,
    careerImportFreshCapability: null,
    careerImportConsumption: null,
    resumeProfile: null,
    careerData: null,
    resumeSummary: null,
    resumeFingerprint: null,
    resumeContext: null,
    filePath: null,
    filePaths: null,
    careerFilePaths: null,
    achievements: null,
    achievementsMining: null,
    queries: null,
    queryCacheKey: null,
    queryModel: null,
    queryCount: null,
    jobPreferencePlan: null,
    jobPreferencesInterpretation: null,
    activeTargetRole: null,
    activeJobPreferences: null,
    pendingJobPreferences: null,
    pendingJobPreferencesInterpretation: null,
    pendingJobPreferencePlan: null,
    preferenceMatchedCount: null,
    preferenceFilteredCount: null,
    preferenceEvaluation: null,
    preferenceCandidatePool: null,
    canonicalLocation: null,
    locationSnapshot: null,
    terminalFinalizationRecovery: null,
    // Kept separately from career identity because it fences a canvas-scoped
    // sidecar that might otherwise arrive after this hub is cleared.
    jobAnalysisClearedAt,
    // The exact run token resolves the otherwise ambiguous Date.now() tie.
    jobAnalysisClearedRunId: normalizeJobAnalysisClearRunId(jobAnalysisClearedRunId),
  };
}

export function canSellHubReplaceFailedInitialPhotos(hub) {
  if (!hub || hub.type !== 'sellhub') return false;
  const data = hub.data || {};
  return !!(
    !data.locked &&
    (data.hubState || 'empty') === 'empty' &&
    data.errorMessage &&
    !data.product
  );
}

export function getHubDropLockReason(hub) {
  if (!hub) return 'missing';
  if (hub.type !== 'jobhub' && hub.type !== 'sellhub') return 'unsupported';

  const data = hub.data || {};
  if (data.locked) return 'locked';
  if (hub.type === 'jobhub' && (
    data.manualAiResume?.retirementPending
    || (Array.isArray(data.manualAiCleanupReceipts)
      && data.manualAiCleanupReceipts.some(receipt => receipt?.cancellationPending === true))
  )) return 'busy';

  const hubState = data.hubState || 'empty';
  if (ACTIVE_INPUT_STATES.has(hubState)) return 'busy';
  if (canSellHubReplaceFailedInitialPhotos(hub)) return null;
  if (hubHasAcceptedInitialDrop(hub)) return 'started';
  if (hubState !== 'empty') return 'started';

  return null;
}

export function canHubAcceptInitialDrop(hub) {
  return getHubDropLockReason(hub) === null;
}

export function canSellHubAcceptDisplayPhotoDrop(hub) {
  if (!hub || hub.type !== 'sellhub') return false;
  const data = hub.data || {};
  if (data.locked) return false;
  return (data.hubState || 'empty') === 'priced';
}

export function getHubFileDropMode(hub) {
  if (canSellHubAcceptDisplayPhotoDrop(hub)) return 'display-photos';
  if (canHubAcceptInitialDrop(hub)) return 'initial-input';
  return null;
}

export function getHubDropRejectLabel(hub) {
  switch (getHubDropLockReason(hub)) {
    case 'locked':
      return 'Locked';
    case 'busy':
      return 'Busy';
    case 'started':
      return 'Already started';
    case 'missing':
    case 'unsupported':
      return 'Unsupported target';
    default:
      return null;
  }
}
