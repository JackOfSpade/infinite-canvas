// A Job Board may begin provider work only for the one import capability that
// was minted when the person explicitly dropped career files after a Clear.
// Keeping the capability separate from career identity is important: a failed
// or cancelled run intentionally retains its profile/files for inspection and
// exact recovery, but that retained identity is not permission to start a new
// generation.

import { currentApprovedCareerImportSnapshot } from './jobCareerCompilationReceipt.js';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function capabilityOwnerNodeId(capability) {
  const token = nonEmptyString(capability);
  const prefix = 'career-import:';
  if (!token || !token.startsWith(prefix)) return null;
  // Node IDs are user/import controlled and can contain colons.  Splitting at
  // the first delimiter (or checking a prefix) would let `a` spend a token for
  // `a:b`.  `createJobCareerImportCapability` puts colon-free entropy last,
  // so the final delimiter is the unambiguous owner boundary while preserving
  // every existing capability format.
  const payload = token.slice(prefix.length);
  const finalDelimiter = payload.lastIndexOf(':');
  if (finalDelimiter <= 0 || finalDelimiter >= payload.length - 1) return null;
  const owner = payload.slice(0, finalDelimiter);
  const entropy = payload.slice(finalDelimiter + 1);
  return !owner || !entropy || entropy.includes(':') ? null : owner;
}

function capabilityBelongsToNode(capability, nodeId) {
  const owner = capabilityOwnerNodeId(capability);
  // The capability is persisted with its node id in clear text so it can
  // survive a workspace reload.  That is not a secret, but it is still an
  // important ownership boundary: a copied/imported hub must not be able to
  // spend the original hub's fresh-import allowance merely by retaining its
  // data object. Capability validation therefore fails closed when the caller
  // cannot name the live Search node it is authorizing.
  return typeof nodeId === 'string' && nodeId.length > 0 && owner === nodeId;
}

function hasRetainedCareerFiles(data) {
  const fields = ['careerFilePaths', 'filePaths'];
  if (fields.some(field => Array.isArray(data?.[field]) && data[field].some(Boolean))) return true;
  return typeof data?.filePath === 'string' && !!data.filePath.trim();
}

function hasUnstartedImportWorkEvidence(data) {
  // A fresh file drop owns no parsed profile/corpus, recovery token, pending
  // handoff, or terminal receipt.  Keep this deliberately conservative: this
  // compatibility escape hatch is only for imports blocked by the old login
  // preflight ordering, never for a provider/parse attempt that merely failed.
  if (
    data?.resumeProfile
    || data?.careerData
    || data?.resumeSummary
    || data?.resumeFingerprint
    || data?.resumeContext
    || data?.jobRunId
  ) return true;
  if (data?.manualAiResume || data?.terminalFinalizationRecovery) return true;
  if (Array.isArray(data?.manualAiCleanupReceipts) && data.manualAiCleanupReceipts.length > 0) return true;
  if (Array.isArray(data?.pendingJobs) || data?.pendingTargetRole || data?.pendingCareerData) return true;
  if (data?.pendingJobPreferences || data?.pendingJobPreferencePlan || data?.pendingJobPreferencesInterpretation) return true;
  if (data?.queries || data?.queryCacheKey || data?.queryModel || data?.queryCount) return true;
  // `locationSnapshot` and `lastCompletedRunAt` are setup bookkeeping: the
  // pre-fix path wrote them before checking login, so neither proves parsing
  // or provider work for the legacy-reclaim decision.
  if (data?.resultDisposition) return true;
  if (Array.isArray(data?.scoredJobs)) return true;
  if (Array.isArray(data?.scrapeWarnings) && data.scrapeWarnings.length > 0) return true;
  if (data?.finalSourceCounts && Object.keys(data.finalSourceCounts).length > 0) return true;
  if ([data?.jobCount, data?.gatheredCount, data?.resultCount, data?.totalScoredCount].some(value => Number(value) > 0)) return true;
  return false;
}

export function createJobCareerImportCapability(nodeId) {
  const entropy = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `career-import:${nodeId || 'jobhub'}:${entropy}`;
}

export function freshJobCareerImportCapability(data, { nodeId } = {}) {
  const generation = nonEmptyString(data?.careerImportGeneration);
  const capability = nonEmptyString(data?.careerImportFreshCapability);
  // The generation/capability pair is deliberately redundant. It makes a
  // hand-edited or partial persisted shape fail closed instead of silently
  // upgrading retained old files into a fresh Board input.
  if (!generation || !capability || generation !== capability) return null;
  if (!capabilityBelongsToNode(capability, nodeId)) return null;
  if (data?.careerImportConsumption != null) return null;
  return capability;
}

/**
 * Recognize an import that an older renderer spent before its login preflight
 * rejected it.  Those pre-fix failures never parsed files or started a
 * provider run, so retaining the old Board consumption would strand a user's
 * unchanged file drop forever after they sign in.  Every observable sign of
 * parsing, provider work, recovery, or a terminal result still fails closed.
 */
export function retryableUnstartedJobCareerImportCapability(data, { nodeId } = {}) {
  if (data?.hubState !== 'empty' || !hasRetainedCareerFiles(data)) return null;
  if (hasUnstartedImportWorkEvidence(data)) return null;
  // An in-memory error is evidence too. The old ordering produced this exact
  // login-gate message; any other retained error belongs to a failed attempt
  // and must not be upgraded into a fresh Board capability. After restart
  // transient errors are intentionally absent, so the structural no-work
  // checks above remain the durable compatibility proof.
  const errorMessage = nonEmptyString(data?.errorMessage);
  if (errorMessage && !/^Log in to .+ first \(Settings → Job Platform Logins\)$/.test(errorMessage)) return null;

  const generation = nonEmptyString(data?.careerImportGeneration);
  const consumption = data?.careerImportConsumption;
  const capability = nonEmptyString(consumption?.capability);
  if (!generation || !capability || generation !== capability) return null;
  if (data?.careerImportFreshCapability != null) return null;
  if (!capabilityBelongsToNode(capability, nodeId)) return null;
  if (
    consumption?.origin !== 'job-board'
    || consumption?.generation !== capability
    || !nonEmptyString(consumption?.boardRunId)
    // Every fixed renderer writes v2 when it claims an import. Only receipts
    // from the pre-fix ordering are eligible for this compatibility reclaim;
    // a v2 claim from another Board remains one-shot and fail-closed.
    || consumption?.admissionVersion != null
  ) return null;
  return capability;
}

export function exactJobCareerImportConsumption(data, {
  capability,
  boardRunId,
  nodeId,
} = {}) {
  const expectedCapability = nonEmptyString(capability);
  if (!expectedCapability || !boardRunId || !capabilityBelongsToNode(expectedCapability, nodeId)) return false;
  const consumption = data?.careerImportConsumption;
  return consumption?.origin === 'job-board'
    && consumption?.capability === expectedCapability
    && consumption?.generation === expectedCapability
    && consumption?.boardRunId === boardRunId
    && nonEmptyString(data?.careerImportGeneration) === expectedCapability
    && data?.careerImportFreshCapability == null;
}

// Used at a Board child's actual lane turn. `fresh` is consumed immediately;
// `owned` is the same Board transaction resuming after its write/crash; the
// narrowly proven pre-fix no-work shape can be atomically reclaimed once.
// No provider-started or partial shape may start a replacement search.
export function jobCareerImportBoardAdmission(data, {
  capability,
  boardRunId,
  nodeId,
} = {}) {
  const expectedCapability = nonEmptyString(capability);
  if (!expectedCapability || !boardRunId || !capabilityBelongsToNode(expectedCapability, nodeId)) {
    return { kind: 'missing' };
  }
  // Capability ownership is necessary but not sufficient. Retained paths and
  // an unspent token can survive a failed or interrupted compiler; provider
  // work may begin only from the exact immutable snapshot it published.
  if (!currentApprovedCareerImportSnapshot(data, { generation: expectedCapability })) {
    return { kind: 'missing' };
  }
  if (freshJobCareerImportCapability(data, { nodeId }) === expectedCapability) {
    return { kind: 'fresh', capability: expectedCapability };
  }
  if (exactJobCareerImportConsumption(data, { capability: expectedCapability, boardRunId, nodeId })) {
    return { kind: 'owned', capability: expectedCapability };
  }
  if (retryableUnstartedJobCareerImportCapability(data, { nodeId }) === expectedCapability) {
    return { kind: 'reclaimable-unstarted', capability: expectedCapability };
  }
  return { kind: 'missing' };
}

export function jobCareerImportConsumptionPatch({
  capability,
  boardRunId = null,
  origin = 'standalone',
} = {}) {
  const token = nonEmptyString(capability);
  if (!token) return null;
  return {
    careerImportFreshCapability: null,
    careerImportConsumption: {
      generation: token,
      capability: token,
      origin,
      // Versioned claims are never reclaimable by another Board. Legacy
      // unversioned receipts are recognized solely to repair the historical
      // login-before-preflight ordering bug.
      admissionVersion: 2,
      ...(boardRunId ? { boardRunId } : {}),
      consumedAt: Date.now(),
    },
  };
}
