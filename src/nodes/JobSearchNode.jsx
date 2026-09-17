import React, { useRef, useEffect, useCallback, useContext, useMemo, useState, useId, useSyncExternalStore } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { useJobSearchCoordinator } from '../contexts/useJobSearchCoordinator';
import { usePlatformsVerifyingProgress } from '../contexts/useSessionStatus';
import { HubContainer } from '../components/HubContainer';
import { Briefcase } from 'lucide-react';
import { JOB_SOURCE_BY_ID, ACTIVE_JOB_SOURCES } from '../utils/constants';
import { isJobSourceEnabledInScope, JOB_SEARCH_TEST_MODE } from '../utils/jobSourceScope';
// Same-run merges use dedupJobsAcrossSources/uniqueJobsAcrossSources — the
// backend's location-aware cross-source dedup — so a posting that arrives
// late (post-Solve resolve, background USAJobs) collapses against the copy
// another board already returned, exactly as it would have in the main
// gather, without over-collapsing distinct same-title/company reqs in
// different cities. See the policy note in jobIdentity.js.
import { dedupJobsAcrossSources, uniqueJobsAcrossSources } from '../utils/jobIdentity';
import { getJobAuthPreflightSourceIds } from '../utils/jobAuthPreflight';
import { mergeResolvedSourceItems } from '../utils/jobSourceResolveMerge';
import { radialRadius, fitViewDuration } from '../utils/layoutGeometry';
import { EventLogger } from '../utils/EventLogger';
import { useToast } from '../components/ToastProvider';
import { buildJobHubCareerClearPatch, getHubDropLockReason, getHubDropRejectLabel, hubHasAcceptedInitialDrop } from '../utils/hubDropEligibility';
import { careerFilesCleanupNeedsWarning, isJobAnalysisSnapshotAfterClear, nextJobAnalysisClearWatermark, normalizeJobAnalysisClearRunId, normalizeJobAnalysisClearWatermark } from '../utils/jobAnalysisRecovery';
import { formatCompletionTimestamp, normalizeCompletionTimestamp } from '../utils/completionTimestamp';
import { filesToDropPayloads, summarizeFileExtensions } from '../utils/fileDropUtils';
import { canAttemptJobSourceResolve, descriptionRecoveryCheckpointWriteFailureWarning, isDescriptionRecoverySourceWarning, isDescriptionRecoveryWarningCode, isJobSourceWarningGating, reconcileJobSourceWarnings } from '../utils/jobSourceWarningPolicy';
import { collectionScopeCaveatsForSavedJobReanalysis, normalizeCollectionScopeCaveats } from '../utils/jobCollectionScopeCaveats';
import { createRunOwnershipGuard } from '../utils/runOwnership';
import { isTerminalSourceStatus } from '../utils/sourceProgress';
import { detectQueryOperators } from '../utils/jobTitleMatch';

import { JobSearchProcessingState } from './jobsearch/JobSearchProcessingState';
import { JobSearchDoneState, SearchBriefAdvisories } from './jobsearch/JobSearchDoneState';
import { JobSearchSourcesReadyState } from './jobsearch/JobSearchSourcesReadyState';
import { HubErrorBanner } from '../components/HubErrorBanner';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation, isNodeDeletedAbort } from '../hooks/useEpochCancellation';
import { useSourceProgress } from '../hooks/useSourceProgress';
import { useIsMountedRef } from '../hooks/useIsMountedRef';
import { pickEdgeHandles, structuralEdge } from './_shared/edgeHelpers';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { JobCollectionLimitsControl } from '../components/JobCollectionLimitsControl';
import { JobPlatformSelectionControl } from '../components/JobPlatformSelectionControl';
import { normalizeJobCollectionLimits } from '../utils/jobCollectionLimits';
import { getRunnableJobSourceIds, normalizeEnabledJobSourceIds } from '../utils/jobPlatformSelection';
import { normalizeLocationInput } from '../utils/jobLocation';
import {
  getSearchLocation,
  hasRequiredLocations,
  locationToLegacyText,
  locationValidationMessage,
  normalizeRemoteResidences,
  normalizeStructuredLocation,
  writeLastRemoteResidences,
} from '../utils/jobSearchLocations';
import { buildExactTargetRoleQueryBundle, buildPinnedTitleQueryBundle, flattenJobSearchQueries } from '../utils/jobSearchQueries';
import { JobSearchLocationFields } from '../components/JobSearchLocationFields';
import { TRANSIENT_PROCESSING_HUB_STATES } from '../utils/persistenceTransientState';
import { findJobSearchBoardActiveRecoveryOwner, findJobSearchBoardPausedContinuationOwner, findJobSearchBoardRecoveryOwner, isJobSearchBoardPausedContinuationBlocked, isJobSearchConnectedToBoard } from '../utils/jobBoardSearchSelection';
import { safeClone } from '../utils/navigationUtils';
import {
  getJobWorkflowDeletionLifecycleRevision,
  isJobWorkflowDeletionPending,
  isJobWorkflowRelocationPending,
  subscribeJobWorkflowDeletionLifecycle,
} from '../utils/nodeDeletionLifecycle';
import { isJobBoardUserCancellation } from '../utils/jobBoardAiProvider';
import { exactInterruptedRecoveryBackendFailure } from '../utils/jobBoardRecoveryAdmission';
import { classifyJobBoardSourceAdmission } from '../utils/jobBoardSourceAdmission';
import { createJobCareerImportCapability, freshJobCareerImportCapability, jobCareerImportBoardAdmission, jobCareerImportConsumptionPatch, retryableUnstartedJobCareerImportCapability } from '../utils/jobCareerImportCapability';
import { moduleFingerprint } from './jobboard/mergeJobs';

// ─── TESTING: optionally skip AI scoring after collection ────────────────────
// Collection limits are always user-controlled; this switch affects scoring only.
const SKIP_AI_FOR_TESTING = JOB_SEARCH_TEST_MODE.enabled && JOB_SEARCH_TEST_MODE.skipAI;
// ─────────────────────────────────────────────────────────────────────────────

// A scrape warning "gates" the pipeline — pauses it in 'sources-ready' until the
// user Solves or Skips — when it's a hard block/paste (captcha, login wall) OR a
// LinkedIn guest rate-limit. The rate-limit is technically a 'throttle', but a
// Solve (switch VPN → re-enrich the missing descriptions) recovers real data, so
// we hold scoring rather than burn AI tokens on description-less LinkedIn jobs;
// the user can still Skip to score with what we have. Everything else (info,
// transient throttles on other sources) flows straight through to scoring.
// Job freshness window (days). Default mirrors electron DEFAULT_MAX_AGE_DAYS;
// the cap bounds the user-set slider. NOTE: auto-widening this on thin results
// would need a search refetch (filterJobsByAge runs post-fetch, so date-param
// sources won't already have older jobs in the pool) — left as a follow-up.
const JOB_DEFAULT_AGE_DAYS   = 21;
const JOB_MAX_AGE_DAYS_LIMIT = 180;

const STATE_LABELS = {
  empty: null,
  parsing: 'Reading resume...',
  'interpreting-preferences': 'Understanding Job Preferences...',
  querying: 'Planning search strategy...',
  searching: 'Searching for jobs...',
  'evaluating-preferences': 'Checking Job Preferences...',
  scoring: 'AI scoring matches...',
  queued: 'Waiting to run...',
  'sources-ready': null,
  done: null,
};

const PROCESSING_STATES = ['queued', 'parsing', 'interpreting-preferences', 'querying', 'searching', 'evaluating-preferences', 'scoring'];
const BOARD_BUSY_SEARCH_STATES = new Set(PROCESSING_STATES);
const SAVED_SCRAPE_MANUAL_AI_RECOVERY_MODES = new Set(['resume-saved-scrape', 'append-scored-jobs']);
const SOURCE_CARD_DISMISS_GRACE_MS = 10_000;

function createManualAiRunId(nodeId) {
  const entropy = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `job-search:${nodeId}:${entropy}`;
}

function rememberBoundedRunId(runIds, runId, limit = 32) {
  if (!runId) return;
  runIds.add(runId);
  while (runIds.size > limit) {
    runIds.delete(runIds.values().next().value);
  }
}

function normalizeManualAiCleanupReceipts(receipts) {
  if (!Array.isArray(receipts)) return [];
  const byRunId = new Map();
  for (const receipt of receipts) {
    if (typeof receipt?.runId !== 'string' || !receipt.runId) continue;
    byRunId.set(receipt.runId, { ...(byRunId.get(receipt.runId) || {}), ...receipt });
  }
  return [...byRunId.values()].slice(-32);
}

function upsertManualAiCleanupReceipt(receipts, receipt) {
  return normalizeManualAiCleanupReceipts([
    ...normalizeManualAiCleanupReceipts(receipts).filter(item => item.runId !== receipt?.runId),
    receipt,
  ]);
}

function removeManualAiCleanupReceipt(receipts, runId) {
  return normalizeManualAiCleanupReceipts(receipts).filter(receipt => receipt.runId !== runId);
}

function hasCancellationPendingManualAiCleanup(data) {
  return normalizeManualAiCleanupReceipts(data?.manualAiCleanupReceipts)
    .some(receipt => receipt.cancellationPending === true);
}

function hasPendingManualAiRetirement(data) {
  return data?.manualAiResume?.retirementPending === true
    || hasCancellationPendingManualAiCleanup(data);
}

// The results cascade (hiring-fit/salary/role tree) is no longer spawned here —
// the Job Search Module scrapes + scores + STORES its scored jobs, and a Job
// Board Module (connected by the user) does the bucketing + display. See
// JobBoardNode.jsx and buildJobTree.js (the shared, hubId-agnostic builder).

function buildResumeSummary(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const skills = Array.isArray(profile.skills) ? profile.skills.slice(0, 3).join(', ') : '';
  return `${skills}${profile.experience_years ? `${skills ? ' · ' : ''}${profile.experience_years}y exp` : ''}`.trim();
}

// Capture the whole done-state score summary before a re-analysis changes the
// visible state to queued/scoring. A failed or cancelled re-analysis restores
// this exact snapshot; success is the only path allowed to replace results.
function reanalysisRestorePatch(data) {
  return {
    scoredJobs: Array.isArray(data?.scoredJobs) ? data.scoredJobs : [],
    resultCount: data?.resultCount,
    totalScoredCount: data?.totalScoredCount,
    scrapedCount: data?.scrapedCount,
    gatheredCount: data?.gatheredCount,
    finalSourceCounts: data?.finalSourceCounts,
    scoreRangeMin: data?.scoreRangeMin,
    scoreRangeMax: data?.scoreRangeMax,
    scoreThreshold: data?.scoreThreshold,
    aiSkipped: data?.aiSkipped,
    collectionOnly: data?.collectionOnly,
    testMode: data?.testMode,
    scrapeWarnings: data?.scrapeWarnings,
    collectionScopeCaveats: normalizeCollectionScopeCaveats(data?.collectionScopeCaveats),
    rerunOutcome: data?.rerunOutcome,
    rerunNotice: data?.rerunNotice,
    jobCount: data?.jobCount,
    resultDisposition: data?.resultDisposition,
    preferenceMatchedCount: data?.preferenceMatchedCount,
    preferenceFilteredCount: data?.preferenceFilteredCount,
    preferenceEvaluation: data?.preferenceEvaluation,
    preferenceCandidatePool: data?.preferenceCandidatePool,
  };
}

// A saved-job re-analysis may spend time behind another Board/search action.
// Compare only its semantic inputs at the actual queue turn; presentation-only
// queue fields must not make the action invalidate itself.
function reanalysisInputFingerprint(data) {
  const source = data && typeof data === 'object' ? data : {};
  return JSON.stringify({
    jobRunId: source.jobRunId || null,
    resultDisposition: source.resultDisposition || null,
    scoredJobs: Array.isArray(source.scoredJobs) ? source.scoredJobs : [],
    preferenceCandidatePool: Array.isArray(source.preferenceCandidatePool)
      ? source.preferenceCandidatePool
      : [],
    resumeProfile: source.resumeProfile || null,
    careerData: source.careerData || '',
    // targetRole: legacy-only (the standalone box is gone; nothing writes this
    // anymore). Kept here so an unmigrated canvas that still carries one
    // continues to invalidate the fingerprint the same way it always did.
    // jobPreferences is the Search Brief field — the box's rename is
    // label-only, so this is already folding the brief.
    targetRole: source.targetRole || '',
    jobPreferences: source.jobPreferences || '',
    locationSnapshot: source.locationSnapshot || null,
    searchLocation: source.searchLocation || null,
    preferredLocation: source.preferredLocation || '',
    canonicalLocation: source.canonicalLocation || '',
    remoteResidences: source.remoteResidences || null,
    gatheredCount: source.gatheredCount ?? null,
    scrapeWarnings: Array.isArray(source.scrapeWarnings) ? source.scrapeWarnings : [],
  });
}

// --- Title derivation: one AI-determined list, one consumer ---------------
//
// `preferencePlan.titles` is the AI's role determination for this brief (see
// jobPreferences.js): if the free-text brief itself names job titles, the AI
// keeps them verbatim inside this list and expands around them (adjacent/
// related titles worth searching too); if the brief names no titles at all,
// the AI works out suitable titles from the brief plus the career profile.
// Either way there is exactly one resolved list, and it drives exactly one
// thing — the search QUERIES. There is no deterministic post-search title
// filter anymore (the old two-mode 'brief'-verbatim-gate/'generated'-gate-off
// split, and jobs.js's applyPinnedTitleGate, are both gone). Role relevance
// is now judged per-listing by the AI role screen that runs inside the
// preference evaluation batch call (main process — see
// electron/ipc/jobPreferences.js). That screen fails OPEN, deliberately
// UNLIKE its siblings in the same call: a strict preference item fails CLOSED
// (an `unverified` outcome drops the job, because an unproven hard
// requirement is not a satisfied one), whereas an `unclear` role verdict
// KEEPS the job. The asymmetry is the whole point — the gate this replaced
// was removed for over-dropping, so the thing replacing it must never
// discard a listing merely because the model could not tell.
// A legacy `targetRole` (unmigrated canvas, no AI-plan concept — the
// standalone Target role box that used to feed
// search-jobs/search-jobs-single-source/resolve-job-source/resume-job-source
// directly, see JobSourceCardNode.jsx) still wins outright, reproducing the
// old single-role search exactly.
function deriveSearchTitles(targetRole, preferencePlan) {
  const role = String(targetRole || '').trim();
  if (role) return [role];
  return Array.isArray(preferencePlan?.titles)
    ? preferencePlan.titles.filter(t => typeof t === 'string' && t.trim())
    : [];
}

// FIX 2 (defence-in-depth): `resolvedRoles.length > 0` used to be the lock-
// existence sentinel everywhere in this module. A resolution that
// legitimately yields ZERO titles (a valid outcome — see resolveSearchRoles)
// still WRITES `resolvedRoles: []`, which that sentinel cannot distinguish
// from "this hub has never locked". Every future scan then re-pays the
// expensive two-pass interpretation handoff (a human copy/paste with no
// timeout) FOREVER, and settingsFrozen never engages. `resolvedRolesMeta` is
// written IFF a resolution actually ran (see freshRoleLockPatch below), so it
// is the one sentinel that is true exactly when the lock exists, empty result
// or not. Every lock-existence check in this module must go through this
// helper instead of re-deriving `resolvedRoles.length > 0` inline.
function hasResolvedRoleLock(source) {
  return !!(source && typeof source === 'object'
    && source.resolvedRolesMeta && typeof source.resolvedRolesMeta === 'object');
}

function buildQueryCacheKey({ resumeFingerprint, jobPreferences, preferredLocation }) {
  return JSON.stringify({
    // v6: the standalone Target role box is gone — the brief (jobPreferences)
    // now carries whatever role signal exists, resolved through a different
    // code path (AI title interpretation instead of a literal typed role), so
    // a v5 cache entry must not be reused even for byte-identical brief text.
    strategyVersion: 6,
    resumeFingerprint: String(resumeFingerprint || ''),
    jobPreferences: String(jobPreferences || '').trim(),
    preferredLocation: String(preferredLocation || '').trim(),
  });
}

// The main process accepts only this full-input parse fingerprint for durable
// recovery. Treat missing, legacy, or malformed values as non-recoverable;
// never synthesize identity from the mutable stored profile object.
function normalizeResumeProfileFingerprint(value) {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : '';
}

// The main process owns the AI/web-research semantics. This deliberately only
// normalizes its response envelope so the renderer can keep older app builds
// working while the preference APIs roll out.
function normalizePreferenceEvaluation(result, fallbackJobs) {
  const fallback = Array.isArray(fallbackJobs) ? fallbackJobs : [];
  if (!result || result.success === false) {
    return { jobs: fallback, candidatePool: fallback, matchedCount: null, filteredCount: null, evaluation: null };
  }
  const jobs = Array.isArray(result.jobs)
    ? result.jobs
    : Array.isArray(result.matchedJobs)
      ? result.matchedJobs
      : Array.isArray(result.acceptedJobs)
        ? result.acceptedJobs
        : fallback;
  const matchedCount = Number.isFinite(result.preferenceMatchedCount)
    ? result.preferenceMatchedCount
    : Number.isFinite(result.matchedCount)
      ? result.matchedCount
      : Number.isFinite(result.counts?.accepted) ? result.counts.accepted : jobs.length;
  const filteredCount = Number.isFinite(result.preferenceFilteredCount)
    ? result.preferenceFilteredCount
    : Number.isFinite(result.filteredCount)
      ? result.filteredCount
      : Number.isFinite(result.counts?.filtered) ? result.counts.filtered : Math.max(0, fallback.length - jobs.length);
  const candidatePool = Array.isArray(result.preferenceCandidatePool)
    ? result.preferenceCandidatePool
    : Array.isArray(result.candidatePool)
      ? result.candidatePool
      : (Array.isArray(result.acceptedJobs) || Array.isArray(result.filteredJobs))
        ? dedupJobsAcrossSources([
            ...(Array.isArray(result.acceptedJobs) ? result.acceptedJobs : []),
            ...(Array.isArray(result.filteredJobs) ? result.filteredJobs : []),
          ])
        : fallback;
  return {
    jobs,
    candidatePool,
    matchedCount,
    filteredCount,
    evaluation: result.preferenceEvaluation || result.evaluation || (
      result.counts || result.audits || result.preferencePlan
        ? { preferencePlan: result.preferencePlan || null, audits: result.audits || [], counts: result.counts || null }
        : null
    ),
  };
}

function mergePreferenceCandidatePools(existing, incoming) {
  const prior = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(incoming) ? incoming : [];
  return dedupJobsAcrossSources([...prior, ...next]);
}

function mergePreferenceEvaluations(existing, incoming) {
  if (!existing) return incoming || null;
  if (!incoming) return existing;
  const numericTotal = (key) => {
    const a = Number(existing?.counts?.[key]);
    const b = Number(incoming?.counts?.[key]);
    return (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
  };
  const audits = [...(Array.isArray(existing.audits) ? existing.audits : []), ...(Array.isArray(incoming.audits) ? incoming.audits : [])];
  // New audits carry a bounded listing identity. Use the same location-aware
  // cross-source identity as the candidate pool: title/company alone merges
  // distinct requisitions in (for example) New York and San Francisco, while
  // URL alone fails to merge the same listing returned by two boards. Legacy
  // audits lack that identity, so retain their old conservative exact fallback.
  const identifiedAudits = audits.filter(audit => audit?.listingIdentity && typeof audit.listingIdentity === 'object');
  const legacyAudits = audits.filter(audit => !audit?.listingIdentity || typeof audit.listingIdentity !== 'object');
  const uniqueIdentifiedAudits = dedupJobsAcrossSources(identifiedAudits.map(audit => ({
    ...audit.listingIdentity,
    title: audit.title,
    company: audit.company,
    __audit: audit,
  }))).map(audit => audit.__audit);
  const uniqueLegacyAudits = legacyAudits.filter((audit, index, list) => {
    const key = `${audit?.title || ''}|${audit?.company || ''}|${audit?.status || ''}|${audit?.summary || ''}`;
    return list.findIndex((candidate) => `${candidate?.title || ''}|${candidate?.company || ''}|${candidate?.status || ''}|${candidate?.summary || ''}` === key) === index;
  });
  const uniqueAudits = audits.filter(audit => (
    (audit?.listingIdentity && typeof audit.listingIdentity === 'object'
      ? uniqueIdentifiedAudits
      : uniqueLegacyAudits
    ).includes(audit)
  ));
  return {
    preferencePlan: incoming.preferencePlan || existing.preferencePlan || null,
    audits: uniqueAudits,
    counts: {
      input: numericTotal('input'), accepted: numericTotal('accepted'), filtered: numericTotal('filtered'),
      strictConflicts: numericTotal('strictConflicts'), strictUnverified: numericTotal('strictUnverified'),
    },
  };
}

// FIX 4: extract the role titles a saved-scrape snapshot was actually
// searched under. See the call site (the getLastJobAnalysisSnapshot effect)
// for why this reads the full snapshot's `jobPreferencePlan.titles` rather
// than the curated `meta.targetRole` the recovery panel used to render.
function savedAnalysisRoleTitles(snapshot) {
  return Array.isArray(snapshot?.jobPreferencePlan?.titles)
    ? snapshot.jobPreferencePlan.titles.filter(t => typeof t === 'string' && t.trim())
    : [];
}

// FIX 5: detectQueryOperators (jobTitleMatch.js) flags Boolean/operator
// syntax (leading "-", NOT/AND/OR, "field:", quotes) that a job board will
// not honor as an operator — measured behaviour is that boards ignore it,
// zero out results entirely, or (ZipRecruiter, negation) invert the intent.
// It was deleted from the UI with the standalone Target role box and is
// referenced by no other application code, but the risk it guards against is
// now LARGER: queries are built from the RESOLVED titles unconditionally
// (deriveSearchTitles), so a title the user typed with quotes or a leading
// minus — kept verbatim inside the AI's resolved list — goes to every job
// board VERBATIM, with no other chokepoint that would ever catch it. This
// is advisory only — never blocks, cancels, or retries a search, exactly like
// SearchBriefAdvisories below, whose amber/role="status" visual contract this
// deliberately mirrors so the two read as one family. Kept as a SEPARATE
// plain function rather than folded into SearchBriefAdvisories itself:
// SearchBriefAdvisories lives in JobSearchDoneState.jsx (out of this file's
// edit scope) and only accepts a `searchBriefPlan` plan object, with no slot
// for a client-side detector's output — this is called as a plain expression
// (`{titleOperatorAdvisory(...)}`, not a JSX `<Tag/>`) immediately next to
// every SearchBriefAdvisories call site in this file's render tree.
// DELIBERATELY lowercase, not a capitalized `<TitleOperatorAdvisory/>` JSX
// component: this file's single default export is one enormous component
// (JobSearchNode), and React Compiler's eslint plugin analyzes every
// capitalized top-level function that returns JSX as an independent
// component to auto-memoize. A second such component in this file made that
// analysis bail out on JobSearchNode itself — confirmed by reverting this
// exact rename during development, which took the file from 12
// react-compiler errors to 0 — silently reverting every one of its manual
// memoizations and turning latent (harmless-when-compiled) ref-during-render
// patterns into real errors. A lowercase plain function returning a React
// element is invisible to that heuristic and sidesteps the whole class of
// failure.
function titleOperatorAdvisory(titles) {
  const hits = new Set();
  for (const title of (Array.isArray(titles) ? titles : [])) {
    for (const hit of detectQueryOperators(title)) hits.add(hit);
  }
  if (hits.size === 0) return null;
  return (
    <div
      className="w-full rounded-md border border-amber-400/25 bg-amber-400/5 px-2 py-1.5 text-[9px] leading-snug text-amber-100/80"
      role="status"
    >
      <p className="font-medium text-amber-200/85 mb-1">Title may not search as typed</p>
      <p>
        Boolean/operator syntax ({[...hits].join(', ')}) in a resolved title is sent to job boards
        as literal words, not honored as a search operator — measured behavior is boards ignore it,
        return zero rows, or invert the intent.
      </p>
    </div>
  );
}

function getSavedAnalysisWarning(meta, currentHubId, currentCanvasFilePath) {
  if (!meta) return '';
  if (meta.canvasFilePath && currentCanvasFilePath && meta.canvasFilePath !== currentCanvasFilePath) {
    return 'Saved from a different canvas file.';
  }
  if (meta.sourceHubId && currentHubId && meta.sourceHubId !== currentHubId) {
    return 'Saved from a different job search hub.';
  }
  return '';
}

function isSavedAnalysisForCurrentHub(snapshot, meta, currentHubId, currentCanvasFilePath, jobAnalysisClearedAt = null, jobAnalysisClearedRunId = null) {
  const sourceHubId = meta?.sourceHubId ?? snapshot?.sourceHubId ?? snapshot?.nodeId ?? null;
  const snapshotCanvasFilePath = meta?.canvasFilePath ?? snapshot?.canvasFilePath ?? null;
  return sourceHubId === currentHubId
    && snapshotCanvasFilePath === currentCanvasFilePath
    && isJobAnalysisSnapshotAfterClear(snapshot, meta, jobAnalysisClearedAt, jobAnalysisClearedRunId);
}

// A saved canvas has a durable run manifest until `complete-job-run` records a
// receipt and clears it. Never silently present a terminal result when that
// finalization failed: the data is still recoverable from the sidecars, but the
// user needs an explicit explanation instead of discovering a surprise Resume
// offer after restarting.
function terminalFinalizationError(runId, canvasFilePath, completion) {
  if (!runId || !canvasFilePath) return null;
  // `ok` means the completion receipt write itself succeeded. The manifest is
  // no longer recoverable only when cleanup was also verified; `{ ok: true,
  // cleared: false }` deliberately reports a partial terminal transaction.
  if (completion?.ok === true && completion?.cleared === true) return null;
  return 'The job search reached a terminal state, but durable job-run finalization did not complete. '
    + 'Recovery data was kept; see Job Recovery Diagnostics before restarting or re-running.';
}

function terminalResultDisposition(terminalOutcome) {
  if (terminalOutcome === 'zero') return 'empty-complete';
  if (terminalOutcome === 'populated') return 'scored';
  if (terminalOutcome === 'collection-only') return 'collection-only';
  if (terminalOutcome === 'preference-filtered') return 'preference-filtered';
  if (terminalOutcome === 'incomplete') return 'incomplete';
  return typeof terminalOutcome === 'string' && terminalOutcome ? terminalOutcome : null;
}

function searchRunOutcome(status, {
  runId = null,
  resultDisposition = null,
  error = null,
  transientReason = null,
  terminalStatus = null,
  terminalOutcome = null,
  scoreReadyCount = null,
  fingerprint = null,
  manualAiRunId = null,
} = {}) {
  return {
    status,
    runId: runId || null,
    resultDisposition: resultDisposition || null,
    ...(terminalStatus ? { terminalStatus } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    ...(scoreReadyCount != null && Number.isFinite(Number(scoreReadyCount))
      ? { scoreReadyCount: Math.max(0, Math.floor(Number(scoreReadyCount))) }
      : {}),
    ...(typeof fingerprint === 'string' && fingerprint ? { fingerprint } : {}),
    ...(manualAiRunId ? { manualAiRunId } : {}),
    ...(typeof transientReason === 'string' && transientReason ? { transientReason } : {}),
    ...(error ? { error: error?.message || String(error) } : {}),
  };
}

function boardCancellationCleanupError(error, fallback) {
  const tagged = error instanceof Error
    ? error
    : new Error(error?.message || fallback || String(error || 'Job Search cancellation cleanup failed.'));
  tagged.code = 'BOARD_CANCELLATION_CLEANUP_FAILED';
  return tagged;
}

function isSavedScrapeManualAiResume(resume) {
  return resume?.task === 'job-scoring'
    || SAVED_SCRAPE_MANUAL_AI_RECOVERY_MODES.has(resume?.recoveryMode);
}

/**
 * Identity for two warning entries that belong to the SAME source, used by the
 * restore paths that re-add a warning which may already sit in the hub's list.
 * Warnings carry no id, so the code+severity pair is the only stable identity
 * available. When the pair differs the two entries are kept side by side on
 * purpose: an extra visible warning stays recoverable (Skip / Score current
 * results), while a wrongly-dropped gate silently un-pauses a blocked run.
 */
function isSameJobSourceWarningEntry(a, b) {
  return (a?.code || null) === (b?.code || null)
    && (a?.severity || null) === (b?.severity || null);
}

// The Board's `awaitingSourceResolution` receipt is the authority for a
// post-Solve/Skip continuation. Revalidate all of it in the child executor:
// the Board can have waited in the shared lane while a user reset, re-ran,
// locked, or disconnected this Search. `recover-staged-scoring` is deliberately
// limited to the sanitizer's nonterminal shape; a genuine done receipt must go
// through the normal Board terminal path instead of re-opening its sidecar.
function isExactPausedBoardScoringContinuation(node, nodeId, boardPlan, boardRunId, continuation) {
  const data = node?.data || {};
  const awaiting = boardPlan?.awaitingSourceResolution;
  if (
    !continuation
    || continuation.sourceId !== nodeId
    || typeof continuation.jobRunId !== 'string'
    || !continuation.jobRunId
    || boardPlan?.version !== 1
    || boardPlan?.phase !== 'searches'
    || boardPlan?.boardRunId !== boardRunId
    || boardPlan?.activeSourceId !== nodeId
    || awaiting?.sourceId !== nodeId
    || awaiting?.jobRunId !== continuation.jobRunId
    || data.jobRunId !== continuation.jobRunId
    || data.manualAiResume?.runId
  ) return false;
  const noGatingWarnings = !(Array.isArray(data.scrapeWarnings)
    ? data.scrapeWarnings
    : []).some(isJobSourceWarningGating);
  if (continuation.mode === 'finish-paused-scoring') {
    return data.hubState === 'sources-ready' && noGatingWarnings;
  }
  return continuation.mode === 'recover-staged-scoring'
    && (data.hubState === 'empty' || data.hubState === 'done')
    && !data.resultDisposition;
}

function boardRunReadiness(node, {
  processing = false,
  platformsVerifying = false,
  manualAiResume = null,
  orchestratorNodeId = null,
  boardRunId = null,
  recoveryOwner = null,
  terminalFinalizationRecovery = false,
  pausedScoringContinuation = false,
  interruptedRecovery = false,
} = {}) {
  if (!node || node.type !== 'jobhub') {
    return searchRunOutcome('not-ready', { error: 'This Job Search module is no longer available.' });
  }
  const liveData = node.data || {};
  const hubState = liveData.hubState || 'empty';
  const persistedManualResume = liveData.manualAiResume;
  const requestedManualRunId = manualAiResume?.runId || null;
  const exactManualRecovery = !!requestedManualRunId
    && persistedManualResume?.runId === requestedManualRunId;
  if (liveData.locked) {
    return searchRunOutcome('not-ready', { error: 'This Job Search module is locked.' });
  }
  if (hasCancellationPendingManualAiCleanup(liveData)) {
    return searchRunOutcome('paused', {
      runId: liveData.jobRunId || null,
      resultDisposition: liveData.resultDisposition || null,
      error: 'Finish the older manual-AI cancellation cleanup before starting this Search.',
    });
  }
  const exactTerminalRetirement = persistedManualResume?.retirementPending
    && exactManualRecovery
    && liveData.hubState === 'done'
    && typeof liveData.jobRunId === 'string'
    && !!liveData.jobRunId
    && typeof liveData.resultDisposition === 'string'
    && !!liveData.resultDisposition;
  if (persistedManualResume?.retirementPending && !exactTerminalRetirement) {
    return searchRunOutcome('paused', {
      runId: liveData.jobRunId || null,
      resultDisposition: liveData.resultDisposition || null,
      error: 'Retry the saved manual-AI cleanup before starting another scan.',
    });
  }
  if (requestedManualRunId && !exactManualRecovery) {
    return searchRunOutcome('not-ready', {
      error: 'The saved manual-AI recovery no longer belongs to this Job Search module.',
    });
  }
  if (!recoveryOwner || (
    recoveryOwner.orchestratorNodeId !== orchestratorNodeId
    || recoveryOwner.boardRunId !== boardRunId
  )) {
    return searchRunOutcome('paused', {
      runId: liveData.jobRunId || null,
      resultDisposition: liveData.resultDisposition || null,
      error: 'This interrupted Job Search belongs to another Job Board transaction.',
    });
  }
  if (persistedManualResume?.runId && !exactManualRecovery) {
    return searchRunOutcome('paused', {
      runId: liveData.jobRunId || null,
      resultDisposition: liveData.resultDisposition || null,
      error: 'This Job Search module has a saved manual-AI step that must be resumed before a fresh scan.',
    });
  }
  if (
    hubState === 'sources-ready'
    && !(exactManualRecovery && isSavedScrapeManualAiResume(manualAiResume))
    && !pausedScoringContinuation
  ) {
    return searchRunOutcome('paused', {
      runId: liveData.jobRunId || null,
      resultDisposition: liveData.resultDisposition || null,
      error: 'Resolve or skip its blocked sources before starting another scan.',
    });
  }
  if (processing || BOARD_BUSY_SEARCH_STATES.has(hubState)) {
    return searchRunOutcome('busy', {
      runId: liveData.jobRunId || null,
      resultDisposition: liveData.resultDisposition || null,
      error: 'This Job Search module is already running.',
    });
  }
  // Retrying a terminal receipt/sidecar cleanup neither queries a platform nor
  // reads career inputs. Once ordinary ownership/busy checks pass, do not let a
  // later settings edit block this exact-token housekeeping transaction.
  if (terminalFinalizationRecovery) return null;
  if (platformsVerifying) {
    return searchRunOutcome('not-ready', {
      error: 'Its selected platform connections are still being checked.',
      transientReason: 'platforms-verifying',
    });
  }
  // The Board inspected an exact, hub-owned manifest immediately before this
  // turn. Its provider set and queries are frozen in that manifest; current
  // source toggles (including all disabled) cannot turn this recovery into a
  // fresh scan. handleResumeRun rechecks the token before any mutation and
  // still enforces the manifest/current-location match.
  if (interruptedRecovery) return null;
  // Saved scoring replays use their own persisted job/profile/location snapshot
  // and intentionally do not refetch any platform. Do not make a later source
  // selection edit invalidate that exact recovery operation.
  if (exactManualRecovery && isSavedScrapeManualAiResume(manualAiResume)) {
    if (!(liveData.resumeProfile && typeof liveData.resumeProfile === 'object')) {
      return searchRunOutcome('not-ready', { error: 'This saved job search has no stored career profile.' });
    }
    return null;
  }
  // The Board's durable descriptor freezes the original generation. Its staged
  // rows/profile are the recovery input, so current source toggles and location
  // edits cannot turn this exact continuation into a fresh provider search.
  if (pausedScoringContinuation) {
    if (!(liveData.resumeProfile && typeof liveData.resumeProfile === 'object')) {
      return searchRunOutcome('not-ready', { error: 'This saved Job Search has no stored career profile.' });
    }
    return null;
  }
  const searchLocation = getSearchLocation(liveData);
  if (!hasRequiredLocations(searchLocation)) {
    return searchRunOutcome('not-ready', { error: locationValidationMessage(searchLocation) });
  }
  const runnableSources = getRunnableJobSourceIds(
    normalizeEnabledJobSourceIds(liveData.enabledSourceIds),
    ACTIVE_JOB_SOURCES,
    normalizeJobCollectionLimits(liveData.collectionLimits),
  );
  if (runnableSources.length === 0) {
    return searchRunOutcome('not-ready', { error: 'Select at least one job platform before running the search.' });
  }
  const hasRetainedFiles = !!(
    liveData.filePath
    || (Array.isArray(liveData.filePaths) && liveData.filePaths.some(Boolean))
    || (Array.isArray(liveData.careerFilePaths) && liveData.careerFilePaths.some(Boolean))
  );
  if (!hasRetainedFiles && !(liveData.resumeProfile && typeof liveData.resumeProfile === 'object')) {
    return searchRunOutcome('not-ready', {
      error: 'This Job Search module has no career files or stored profile.',
    });
  }
  return null;
}

function captureJobSourceGraph(hubId, nodes, edges) {
  const allNodes = Array.isArray(nodes) ? nodes : [];
  const allEdges = Array.isArray(edges) ? edges : [];
  const ownedNodes = allNodes.filter(node => node?.type === 'jobsourcecard' && node.data?.hubId === hubId);
  const ownedIds = new Set(ownedNodes.map(node => node.id));
  return safeClone({
    nodes: ownedNodes,
    edges: allEdges.filter(edge => ownedIds.has(edge?.source) || ownedIds.has(edge?.target)),
    // Payload alone is insufficient for an exact rollback: a card dismissed
    // during the abandoned run would otherwise be appended after unrelated
    // equal-z nodes when recreated, changing both paint and serialization order.
    // Keep only ids for the surrounding graph so unrelated node data is never
    // rolled back, while still giving every restored item stable live anchors.
    nodeOrder: allNodes.map(node => node?.id).filter(Boolean),
    edgeOrder: allEdges.map(edge => edge?.id).filter(Boolean),
  });
}

function insertRestoredItemsAtCapturedAnchors(currentItems, restoredItems, capturedOrder, isAffected) {
  const restored = Array.isArray(restoredItems) ? restoredItems : [];
  const restoredById = new Map(restored.map(item => [item?.id, item]).filter(([itemId]) => !!itemId));
  const requestedOrder = Array.isArray(capturedOrder) ? capturedOrder.filter(Boolean) : [];
  const orderIndex = new Map(requestedOrder.map((itemId, index) => [itemId, index]));
  const result = (Array.isArray(currentItems) ? currentItems : []).filter(item => !isAffected(item));

  // Preserve every unrelated item's current relative order. Restored source
  // items are inserted against the nearest still-live pre-run neighbor; only
  // when all anchors disappeared do we fall back to the captured array index.
  const orderedRestored = [...restored].sort((left, right) => (
    (orderIndex.get(left?.id) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndex.get(right?.id) ?? Number.MAX_SAFE_INTEGER)
  ));
  orderedRestored.forEach((item) => {
    if (!item?.id || result.some(candidate => candidate?.id === item.id)) return;
    const capturedIndex = orderIndex.get(item.id);
    let insertionIndex = -1;
    if (capturedIndex != null) {
      for (let next = capturedIndex + 1; next < requestedOrder.length; next += 1) {
        const liveIndex = result.findIndex(candidate => candidate?.id === requestedOrder[next]);
        if (liveIndex >= 0) {
          insertionIndex = liveIndex;
          break;
        }
      }
      if (insertionIndex < 0) {
        for (let previous = capturedIndex - 1; previous >= 0; previous -= 1) {
          const liveIndex = result.findIndex(candidate => candidate?.id === requestedOrder[previous]);
          if (liveIndex >= 0) {
            insertionIndex = liveIndex + 1;
            break;
          }
        }
      }
    }
    if (insertionIndex < 0) {
      insertionIndex = Math.min(capturedIndex ?? result.length, result.length);
    }
    result.splice(insertionIndex, 0, restoredById.get(item.id));
  });
  return result;
}

function waitForRendererCommitFrame() {
  return new Promise((resolve) => {
    let settled = false;
    let fallbackTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (fallbackTimer != null) clearTimeout(fallbackTimer);
      resolve();
    };
    // A hidden/minimized Electron window can throttle animation frames. Keep a
    // short timer fallback so a completed source never holds the Board lane
    // indefinitely merely because the canvas is not being painted right now.
    fallbackTimer = setTimeout(finish, 50);
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(finish);
    }
  });
}

function sourceGraphRollbackIsVisible(hubId, nodes, edges, snapshot) {
  const expectedNodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const expectedEdges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
  const liveNodes = (Array.isArray(nodes) ? nodes : [])
    .filter(node => node?.type === 'jobsourcecard' && node.data?.hubId === hubId);
  if (liveNodes.length !== expectedNodes.length) return false;
  const liveById = new Map(liveNodes.map(node => [node.id, node]));
  if (!expectedNodes.every((node) => {
    const live = liveById.get(node.id);
    return live
      && live.data?.sourceId === node.data?.sourceId
      && JSON.stringify(live.data?.persistedProgress || null)
        === JSON.stringify(node.data?.persistedProgress || null);
  })) return false;

  const affectedIds = new Set(expectedNodes.map(node => node.id));
  const liveIncidentEdges = (Array.isArray(edges) ? edges : []).filter(edge => (
    affectedIds.has(edge?.source)
    || affectedIds.has(edge?.target)
    || String(edge?.source || '').startsWith(`js-${hubId}-`)
    || String(edge?.target || '').startsWith(`js-${hubId}-`)
  ));
  if (liveIncidentEdges.length !== expectedEdges.length) return false;
  const liveEdgeById = new Map(liveIncidentEdges.map(edge => [edge.id, edge]));
  return expectedEdges.every((edge) => {
    const live = liveEdgeById.get(edge.id);
    return live && live.source === edge.source && live.target === edge.target;
  });
}

async function waitForBoardRollbackCommit({
  getNode,
  getNodes,
  getEdges,
  nodeId,
  rollback,
  sourceGraph,
}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForRendererCommitFrame();
    const live = getNode(nodeId)?.data;
    if (!live) return true;
    const hubVisible = live.hubState === rollback.hubState
      && live.queuedModuleRun == null
      && (live.jobRunId || null) === (rollback.jobRunId || null)
      && live.manualAiResume == null;
    if (hubVisible && sourceGraphRollbackIsVisible(nodeId, getNodes(), getEdges(), sourceGraph)) {
      return true;
    }
  }
  return false;
}

async function waitForCommittedSearchOutcome({ getNode, nodeId, outcome, cancelled }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForRendererCommitFrame();
    if (cancelled()) return searchRunOutcome('cancelled', { runId: outcome?.runId });
    const live = getNode(nodeId)?.data;
    if (!live) return searchRunOutcome('cancelled', { runId: outcome?.runId });
    const runMatches = (live.jobRunId || null) === (outcome?.runId || null);
    const dispositionMatches = (live.resultDisposition || null) === (outcome?.resultDisposition || null);
    if (live.hubState !== 'done' || !runMatches || !dispositionMatches) continue;

    const terminalRecovery = live.terminalFinalizationRecovery;
    if (outcome?.status === 'recovery-finalization-failed') {
      if (
        terminalRecovery?.kind === 'terminal-finalization'
        && terminalRecovery.runId === outcome.runId
      ) {
        return searchRunOutcome('recovery-finalization-failed', {
          ...terminalRecovery,
          runId: terminalRecovery.runId,
          resultDisposition: terminalRecovery.resultDisposition || live.resultDisposition || outcome.resultDisposition,
          scoreReadyCount: terminalRecovery.scoreReadyCount,
          fingerprint: terminalRecovery.fingerprint || moduleFingerprint(live.scoredJobs),
          error: outcome.error || live.errorMessage,
        });
      }
      continue;
    }

    const manualRetirement = live.manualAiResume;
    if (manualRetirement?.runId && manualRetirement.retirementPending) {
      return searchRunOutcome('recovery-cleanup-failed', {
        runId: live.jobRunId,
        resultDisposition: live.resultDisposition,
        terminalStatus: live.resultDisposition === 'incomplete' ? 'failed' : 'completed',
        terminalOutcome: live.resultDisposition === 'empty-complete'
          ? 'zero'
          : live.resultDisposition === 'scored'
            ? 'populated'
            : live.resultDisposition,
        scoreReadyCount: Array.isArray(live.scoredJobs) ? live.scoredJobs.length : null,
        fingerprint: moduleFingerprint(live.scoredJobs),
        manualAiRunId: manualRetirement.runId,
        error: live.errorMessage || 'The saved manual-AI handoff cleanup did not finish.',
      });
    }

    if (!live.errorMessage) {
      return outcome;
    }
  }
  if (outcome?.status === 'recovery-finalization-failed') {
    return searchRunOutcome('recovery-inspection-failed', {
      runId: outcome?.runId,
      resultDisposition: outcome?.resultDisposition,
      error: 'The Job Search terminal cleanup failed, but its exact canvas descriptor was not committed yet. Retry recovery.',
    });
  }
  return searchRunOutcome('failed', {
    runId: outcome?.runId,
    resultDisposition: outcome?.resultDisposition,
    error: 'The Job Search completed, but its terminal result was not committed to the canvas.',
  });
}

function boardRunRollbackPatch(previousData, nodeId) {
  const prior = previousData && typeof previousData === 'object' ? previousData : {};
  const restoreDone = prior.hubState === 'done';
  const freshImportCapability = freshJobCareerImportCapability(prior, { nodeId });
  return {
    ...prior,
    // A cancelled Board must not restore an unconsumed import capability from
    // its pre-run snapshot. The retained profile can still support exact
    // recovery, but a new provider run requires Clear + re-import.
    ...(freshImportCapability ? jobCareerImportConsumptionPatch({
      capability: freshImportCapability,
      origin: 'board-cancelled',
    }) : {}),
    hubState: restoreDone ? 'done' : 'empty',
    queuedModuleRun: null,
    manualAiResume: null,
    // A Board-managed run can be cancelled while one of these fields names
    // the abandoned run. Previous completed results are safe to restore, but
    // no paused/manual continuation may survive the rollback.
    pendingJobs: null,
    pendingTargetRole: null,
    pendingCareerData: null,
    pendingJobPreferences: null,
    pendingJobPreferencePlan: null,
    pendingJobPreferencesInterpretation: null,
    ...(restoreDone ? {} : {
      jobRunId: null,
      scoredJobs: null,
      finalSourceCounts: {},
      resultCount: 0,
      totalScoredCount: 0,
      scrapedCount: 0,
      gatheredCount: 0,
      resultDisposition: null,
      errorMessage: null,
    }),
  };
}

/**
 * JobSearchNode — draggable canvas module for job search.
 * Phase 2: Per-source independent status tracking + source filtering.
 *
 * data.hubState: 'empty' | 'parsing' | 'querying' | 'searching' | 'scoring' |
 *                'sources-ready' | 'done'
 *                'sources-ready' = paused after search because one or more
 *                sources hit block-severity warnings (captcha, login wall).
 *                The user must resolve or skip them before scoring runs.
 *                Failures set data.errorMessage (surfaced via HubErrorBanner)
 *                but stay in the logical step rather than wiping to an error wall.
 * data.filePath: string (set when auto-created from canvas file drop)
 * data.resultCount: number
 * data.errorMessage: string
 * data.resumeSummary: string
 */
export const JobSearchNode = React.memo(function JobSearchNode({ id, data }) {

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, getNode, getNodes, getEdges, setNodes, setEdges, addNodes, addEdges, deleteElements, fitView } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const canvasFilePath = nav?.currentFile || null;
  const moduleRunQueue = useModuleRunQueue();
  const jobSearchCoordinator = useJobSearchCoordinator();
  const jobPreferencesHelpId = useId();
  const processingRunsRef = useRef(createRunOwnershipGuard());
  // Exact ownership record for the one Board-invoked top-level search this hub
  // can execute at a time. Its cancellation handler verifies both identities so
  // late cleanup from an older Board run cannot abort a newer run of this hub.
  const boardRunControlRef = useRef(null);
  // The processing card and global manual-AI dialog are declared before the
  // coordinator canceller below. Route those UI events through this ref so an
  // active Board child always takes the exact identity-checked rollback path.
  const cancelBoardRunRef = useRef(null);
  // Saved-scrape recovery is declared below the coordinator runner. Keep a
  // late-bound reference so the runner can resume that exact branch without
  // reading a later `const` in its dependency array during render.
  const resumeSavedScrapeRef = useRef(null);
  // Crash/quit recovery is declared before the Board coordinator runner for
  // the same reason. A recovered Board must probe and resume the source's
  // exact staged run while retaining the Board's outer queue lease.
  const resumeInterruptedRunRef = useRef(null);
  // The app-level dialog reports immutable manual run ids. Keep the currently
  // published request identity so a late cancellation for an older standalone
  // run cannot reset whichever workflow now owns this hub.
  const activeManualAiRunIdRef = useRef(data.manualAiResume?.runId || null);
  // A prompt notification can already be queued in the renderer when normal
  // completion or cancellation retires its durable manual run. Remember those
  // exact run ids so a late notification cannot recreate `manualAiResume`.
  const cancelledBoardManualAiRunIdsRef = useRef(new Set());
  const attemptedManualAiCleanupRunIdsRef = useRef(new Set());
  const manualAiCleanupErrorMessagesRef = useRef(new Set(
    [
      data.manualAiResume?.cleanupError,
      ...normalizeManualAiCleanupReceipts(data.manualAiCleanupReceipts)
        .map(receipt => receipt.cleanupError),
    ].filter(Boolean),
  ));
  for (const cleanupError of [
    data.manualAiResume?.cleanupError,
    ...normalizeManualAiCleanupReceipts(data.manualAiCleanupReceipts)
      .map(receipt => receipt.cleanupError),
  ].filter(Boolean)) {
    manualAiCleanupErrorMessagesRef.current.add(cleanupError);
  }
  while (manualAiCleanupErrorMessagesRef.current.size > 64) {
    manualAiCleanupErrorMessagesRef.current.delete(
      manualAiCleanupErrorMessagesRef.current.values().next().value,
    );
  }
  // Present only while the done-state re-analysis owns the run guard. It lets
  // either cancel route (the in-card X or Non-API AI dialog) restore the prior
  // scored results instead of treating this as a full search reset.
  const reanalysisRestoreRef = useRef(null);
  // Queue admission is intentionally separate from processing ownership.
  // Holding the processing guard while merely waiting would make an earlier
  // Board skip this Search as busy and then combine an inconsistent snapshot.
  const localQueueAdmissionRef = useRef(null);
  const standaloneCancellationRef = useRef(null);
  const initialDropAcceptedRef = useRef(false);
  // Legacy drop-created hubs persist the source file path so they can begin
  // after React mounts.  Keep the one automatic launch scoped to this mounted
  // node and this exact path: failures intentionally retain the path for the
  // explicit Try Again action, but must never recursively re-launch themselves
  // merely because they return the hub to its empty state.
  const autoStartedFilePathRef = useRef(null);
  const pendingUSAJobsRefreshRef = useRef(false);
  const usaJobsRefreshAdmissionRef = useRef(null);
  const scrapeWarningsRef = useRef(data.scrapeWarnings);
  const hubStateRef = useRef(data.hubState);
  const pendingJobsRef = useRef(data.pendingJobs);
  // The collection total is established before a blocked source pauses the
  // pipeline. Keep it in a ref beside pendingJobs so a same-tick Solve/Skip can
  // resume scoring before React commits the paused node data.
  const gatheredCountRef = useRef(data.gatheredCount ?? 0);
  const jobRunIdRef = useRef(data.jobRunId || null);
  // An explicit career-file clear is a durable recovery boundary. Keep the
  // current watermark in a ref too: a peekJobRun request already in flight
  // when the person clears can then retire its stale result before React has
  // rendered the cleared node data.
  const careerClearWatermarkRef = useRef(normalizeJobAnalysisClearWatermark(data.jobAnalysisClearedAt));
  // Source actions made WHILE the search is running (cleared at each run
  // start). The backend cannot see them, so retain the latest successful state
  // per source for reconciliation with its final warning list. `null` means an
  // explicit Skip/dismiss or a clean successful resolve.
  const sourceWarningOverridesDuringSearchRef = useRef(new Map());
  const resumeScoringRef = useRef(null);
  // One paused generation can be continued from two UI paths at once: a
  // manually queued "Score current results" click and the synchronous
  // continuation emitted by a Source Solve that already owns the job-search
  // lane. Keep those admissions distinct from the top-level Search latch. An
  // externally-managed continuation may supersede a queued one (awaiting that
  // queued promise from inside the Source lease would deadlock); the queued
  // call then reaches its turn and exits at the identity/live-state fence.
  const scoringContinuationAdmissionRef = useRef(null);
  const isMountedRef = useIsMountedRef();
  const settingsDebounceTimerRef = useRef(null);
  const sourceDismissTimerRef = useRef(null);
  const epoch = useEpochCancellation();
  const { addToast } = useToast();
  // Queue admission can be rejected while an OS-backed delete confirmation is
  // pending. React state does not otherwise change when that confirmation is
  // cancelled, so recovery effects need this external-store revision to wake
  // and retry without consuming their one-shot refs permanently.
  const deletionLifecycleRevision = useSyncExternalStore(
    subscribeJobWorkflowDeletionLifecycle,
    getJobWorkflowDeletionLifecycleRevision,
    getJobWorkflowDeletionLifecycleRevision,
  );
  // Connection ownership is live canvas state, not persisted Job Search data.
  // Subscribe for copy/action rendering, then re-read imperatively at every
  // direct launch boundary so an edge added in the same interaction cannot race
  // a stale render and let the child acquire its own queue turn.
  const managedByJobBoard = useStore(
    useCallback(
      store => isJobSearchConnectedToBoard(id, store.nodeLookup, store.edges),
      [id],
    ),
  );
  const activeBoardRecoveryOwnerKey = useStore(
    useCallback((store) => {
      const owner = findJobSearchBoardActiveRecoveryOwner(
        id,
        store.nodeLookup,
        store.edges,
      );
      return owner ? `${owner.orchestratorNodeId}:${owner.boardRunId}` : '';
    }, [id]),
  );
  // Most durable Board recovery ownership makes direct Search controls dead
  // ends. The sole source-ready exception is the exact child generation a
  // Board has paused for source resolution; that continuation must still be
  // able to score after its source decisions are complete.
  const pausedBoardContinuationOwnerKey = useStore(
    useCallback((store) => {
      const jobRunId = store.nodeLookup.get(id)?.data?.jobRunId || null;
      const owner = findJobSearchBoardPausedContinuationOwner(
        id,
        jobRunId,
        store.nodeLookup,
        store.edges,
      );
      return owner ? `${owner.orchestratorNodeId}:${owner.boardRunId}` : '';
    }, [id]),
  );
  // An interrupted Board run retains durable ownership while its edge is being
  // removed or its cancellation cleanup commits.  Treat that reservation like
  // a live connection for every child action that would otherwise be refused
  // by its launch handler.  This intentionally does not hide source-card
  // resolution: a matching paused Board continuation still needs those
  // decisions to complete.
  const boardRecoveryOwnsActions = managedByJobBoard || !!activeBoardRecoveryOwnerKey;
  const deferDirectSearchToBoard = useCallback((trigger, description = null) => {
    if (!isJobSearchConnectedToBoard(id, getNodes(), getEdges())) return false;
    EventLogger.log(`[JobSearch][${id}] ${trigger} saved without scanning — connected Job Board owns search admission`);
    addToast({
      title: 'Run from Job Board',
      description: description || 'Use Search selected & combine on the connected Job Board to run this module.',
      type: 'info',
      dedupeKey: `job-search-run-from-board:${id}`,
    });
    return true;
  }, [addToast, getEdges, getNodes, id]);
  const completeJobRun = useCallback(async (
    runId,
    terminalStatus,
    terminalOutcome,
    completionCanvasFilePath = canvasFilePath,
    scoreReadyCount = null,
    fingerprint = null,
    isCancelled = () => false,
  ) => {
    if (!runId) return null;
    const canPublish = () => {
      try {
        return !isCancelled();
      } catch {
        // A stale/broken owner predicate must fail closed. The main process may
        // still finish its idempotent receipt cleanup, but this renderer no
        // longer has authority to recreate recovery state after Reset/rollback.
        return false;
      }
    };
    // A queued continuation can reach this helper after its renderer owner was
    // cancelled. Do not start another durable ledger mutation once that exact
    // generation has withdrawn authority.
    if (!canPublish()) return null;
    const finalizationRecovery = completionCanvasFilePath ? {
      kind: 'terminal-finalization',
      runId,
      terminalStatus,
      terminalOutcome,
      scoreReadyCount: scoreReadyCount != null && Number.isFinite(Number(scoreReadyCount))
        ? Math.max(0, Math.floor(Number(scoreReadyCount)))
        : null,
      resultDisposition: terminalResultDisposition(terminalOutcome),
      ...(typeof fingerprint === 'string' && fingerprint ? { fingerprint } : {}),
      updatedAt: Date.now(),
    } : null;
    const recordFinalizationState = (failed) => {
      if (!completionCanvasFilePath || !canPublish()) return;
      updateGlobal(id, (node) => {
        if (!canPublish()) return null;
        const existing = node?.data?.terminalFinalizationRecovery;
        if (failed) return { terminalFinalizationRecovery: finalizationRecovery };
        return existing?.runId === runId
          ? { terminalFinalizationRecovery: null }
          : null;
      });
    };
    if (!window.electronAPI?.completeJobRun) {
      recordFinalizationState(true);
      return null;
    }
    try {
      const result = await window.electronAPI.completeJobRun({
        canvasFilePath: completionCanvasFilePath,
        nodeId: id,
        runId,
        terminalStatus,
        terminalOutcome,
        scoreReadyCount,
      });
      if (!canPublish()) return result;
      if (result?.ok !== true || (completionCanvasFilePath && result?.cleared !== true)) {
        recordFinalizationState(true);
        EventLogger.error(
          `[JobSearch][${id}] Job-run completion receipt/cleanup was not fully recorded`
          + ` run=${runId} cleared=${result?.cleared === true ? 'yes' : 'no'}`,
        );
      } else if (terminalStatus === 'completed') {
        recordFinalizationState(false);
        const completedAt = normalizeCompletionTimestamp(result?.receipt?.completedAt);
        if (completedAt != null) {
          updateGlobal(id, () => canPublish() ? { lastCompletedRunAt: completedAt } : null);
        }
      } else recordFinalizationState(false);
      return result;
    } catch (error) {
      if (!canPublish()) return null;
      recordFinalizationState(true);
      EventLogger.error(`[JobSearch][${id}] Job-run completion receipt/cleanup failed run=${runId}:`, error);
      return null;
    }
  }, [canvasFilePath, id, updateGlobal]);
  const retryTerminalFinalization = useCallback(async (descriptor, cancelled = () => false) => {
    const runId = typeof descriptor?.runId === 'string' ? descriptor.runId : '';
    const expectedDisposition = typeof descriptor?.resultDisposition === 'string'
      ? descriptor.resultDisposition
      : null;
    if (!runId) {
      return searchRunOutcome('recovery-finalization-failed', {
        error: 'The interrupted terminal cleanup is missing its exact Job Search run token.',
      });
    }

    const before = getNode(id)?.data || {};
    const beforeFingerprint = moduleFingerprint(before.scoredJobs);
    const liveResultMatches = before.hubState === 'done'
      && before.jobRunId === runId
      && (!expectedDisposition || before.resultDisposition === expectedDisposition)
      && (!descriptor?.fingerprint || beforeFingerprint === descriptor.fingerprint);
    if (!liveResultMatches) {
      // Do not consume the exact terminal ledger (or clear this durable marker)
      // when the canvas no longer displays the result it describes. Reset can
      // explicitly discard the obsolete run; an automatic/retry path must fail
      // closed so it cannot bless or erase a different visible generation.
      return searchRunOutcome('failed', {
        runId,
        resultDisposition: expectedDisposition,
        error: 'The Job Search result changed before its terminal cleanup could be retried.',
      });
    }
    const terminalOutcome = ['zero', 'populated', 'collection-only', 'preference-filtered', 'incomplete']
      .includes(descriptor?.terminalOutcome)
      ? descriptor.terminalOutcome
      : (expectedDisposition === 'empty-complete'
          ? 'zero'
          : expectedDisposition === 'scored'
            ? 'populated'
            : expectedDisposition || 'unknown');
    const terminalStatus = ['completed', 'failed', 'aborted'].includes(descriptor?.terminalStatus)
      ? descriptor.terminalStatus
      : (terminalOutcome === 'incomplete' ? 'failed' : 'completed');
    const scoreReadyCount = descriptor?.scoreReadyCount != null
      && Number.isFinite(Number(descriptor.scoreReadyCount))
      ? Math.max(0, Math.floor(Number(descriptor.scoreReadyCount)))
      : (Array.isArray(before.scoredJobs) ? before.scoredJobs.length : null);
    const completion = await completeJobRun(
      runId,
      terminalStatus,
      terminalOutcome,
      canvasFilePath,
      scoreReadyCount,
      descriptor?.fingerprint || null,
      cancelled,
    );
    if (cancelled()) return searchRunOutcome('cancelled', { runId, resultDisposition: expectedDisposition });
    const finalizationError = terminalFinalizationError(runId, canvasFilePath, completion);
    if (finalizationError) {
      return searchRunOutcome('recovery-finalization-failed', {
        runId,
        resultDisposition: expectedDisposition,
        error: finalizationError,
      });
    }
    const after = getNode(id)?.data || {};
    if (
      after.hubState !== 'done'
      || after.jobRunId !== runId
      || (expectedDisposition && after.resultDisposition !== expectedDisposition)
      || (descriptor?.fingerprint && moduleFingerprint(after.scoredJobs) !== descriptor.fingerprint)
    ) {
      return searchRunOutcome('failed', {
        runId,
        resultDisposition: expectedDisposition,
        error: 'The Job Search result changed while terminal cleanup was settling.',
      });
    }
    updateGlobal(id, { errorMessage: null });
    return searchRunOutcome('completed', { runId, resultDisposition: expectedDisposition });
  }, [canvasFilePath, completeJobRun, getNode, id, updateGlobal]);
  const [savedAnalysisMeta, setSavedAnalysisMeta] = useState(null);
  const [savedAnalysisLoading, setSavedAnalysisLoading] = useState(false);
  // Normalize before any renderer-to-main call. Existing canvases may not have
  // this newer node field, but the backend still needs explicit production
  // defaults for reproducible collection telemetry.
  const jobsPerPlatform = data.collectionLimits?.jobsPerPlatform;
  const pagesPerPlatform = data.collectionLimits?.pagesPerPlatform;
  const collectionLimits = useMemo(
    () => normalizeJobCollectionLimits({ jobsPerPlatform, pagesPerPlatform }),
    [jobsPerPlatform, pagesPerPlatform],
  );
  const setCollectionLimits = useCallback((limits) => {
    updateGlobal(id, { collectionLimits: normalizeJobCollectionLimits(limits) });
  }, [id, updateGlobal]);
  // A missing allow-list is the saved-canvas-compatible "all platforms" default.
  // The effective list also excludes any platform temporarily unsafe under the
  // selected breadth settings; its persisted preference remains intact and
  // automatically returns when those settings become safe again.
  const enabledSourceIds = useMemo(
    () => normalizeEnabledJobSourceIds(data.enabledSourceIds),
    [data.enabledSourceIds],
  );
  const activeEnabledSourceIds = useMemo(
    () => getRunnableJobSourceIds(enabledSourceIds, ACTIVE_JOB_SOURCES, collectionLimits),
    [enabledSourceIds, collectionLimits],
  );
  const setEnabledSourceIds = useCallback((sourceIds) => {
    const previous = normalizeEnabledJobSourceIds(data.enabledSourceIds);
    const next = normalizeEnabledJobSourceIds(sourceIds);
    const added = next.filter(sourceId => !previous.includes(sourceId));
    const removed = previous.filter(sourceId => !next.includes(sourceId));
    if (added.length || removed.length) {
      EventLogger.log(
        `[JobSearch][${id}] Platform selection changed: ${previous.join(',') || '(none)'} → ${next.join(',') || '(none)'}`
        + `${added.length ? `; enabled=${added.join(',')}` : ''}${removed.length ? `; disabled=${removed.join(',')}` : ''}`,
      );
    }
    updateGlobal(id, { enabledSourceIds: next });
  }, [id, data.enabledSourceIds, updateGlobal]);
  // Same source list as runPipeline's hard login preflight (getJobAuthPreflightSourceIds)
  // — a hand-copied subset here would let the "Checking connections…" gate clear
  // while a platform's own startup verify (which seeds from this same list, see
  // getJobLoginPlatforms) is still in flight, unblocking drops on a stale cache.
  const enabledBrowserLoginSourceIds = useMemo(
    () => getJobAuthPreflightSourceIds(ids => ids.filter(sourceId => activeEnabledSourceIds.includes(sourceId))),
    [activeEnabledSourceIds],
  );
  useEffect(() => {
    return () => {
      if (settingsDebounceTimerRef.current) {
        clearTimeout(settingsDebounceTimerRef.current);
      }
      if (sourceDismissTimerRef.current) {
        clearTimeout(sourceDismissTimerRef.current);
      }
    };
  }, []);
  // Stable ref to startProcessing so handleDrop can call it without a stale closure.
  const startProcessingRef = useRef(null);
  // Persists the last file path(s) dropped this session so retry works even when
  // the login-gate fires before the files are parsed (at which point neither
  // data.filePath nor data.resumeProfile are set yet). Holds an array — a drop
  // can be one or many files.
  const lastDroppedPathsRef = useRef(null);

  const hubState = data.hubState || 'empty';
  // A cancelled run is rerunnable only once parsing has produced this persisted
  // profile. Before then, cancelling must return the hub to a true first-drop
  // state rather than leaving it locked with nothing usable to rerun.
  const hasReusableCareerProfile = !!(data.resumeProfile && typeof data.resumeProfile === 'object');
  const hasRetainedCareerFiles = !!(
    data.filePath
    || (Array.isArray(data.filePaths) && data.filePaths.some(Boolean))
    || (Array.isArray(data.careerFilePaths) && data.careerFilePaths.some(Boolean))
  );
  const hasRunnableCareerInput = hasReusableCareerProfile || hasRetainedCareerFiles;
  // Whether the hub actually holds career identity (files/profile/lock), as
  // opposed to being drop-blocked for an unrelated reason such as `locked`.
  const hasCareerIdentity = hubHasAcceptedInitialDrop({ type: 'jobhub', data });
  const dropLockReason = getHubDropLockReason({ type: 'jobhub', data });
  const inputDropsBlocked = !!dropLockReason;
  const { verifying: platformsVerifying, done: verifyDone, total: verifyTotal } = usePlatformsVerifyingProgress(enabledBrowserLoginSourceIds);
  // Queue callbacks can wait behind another job workflow long enough for the
  // connection-verification store to change. Read this at the actual lane turn
  // instead of trusting the render that enqueued the request.
  const platformsVerifyingRef = useRef(platformsVerifying);
  platformsVerifyingRef.current = platformsVerifying;
  const lastCompletedRunAtText = formatCompletionTimestamp(data.lastCompletedRunAt);

  useEffect(() => {
    if (data.inputLocked || data.careerData || data.resumeProfile || data.filePath) {
      initialDropAcceptedRef.current = true;
    }
  }, [data.inputLocked, data.careerData, data.resumeProfile, data.filePath]);

  // Chrome manual-launch overlay — shown when the app couldn't auto-launch
  // Chrome with the debug port and the user needs to do it via Terminal.
  // Payload: { terminalCommand, port } or null.
  const [chromeLaunchInfo, setChromeLaunchInfo] = useState(null);

  useEffect(() => {
    if (!window.electronAPI?.onChromeLaunchNeeded) return;
    const c1 = window.electronAPI.onChromeLaunchNeeded((payload) => setChromeLaunchInfo(payload));
    const c2 = window.electronAPI.onChromeLaunchConnected?.(() => setChromeLaunchInfo(null));
    const c3 = window.electronAPI.onChromeLaunchDismissed?.(() => setChromeLaunchInfo(null));
    return () => { c1?.(); c2?.(); c3?.(); };
  }, []);
  const statusLabel = STATE_LABELS[hubState];

  useEffect(() => {
    scrapeWarningsRef.current = data.scrapeWarnings;
    hubStateRef.current = data.hubState;
    pendingJobsRef.current = data.pendingJobs;
    gatheredCountRef.current = data.gatheredCount ?? 0;
    // Adopt a committed token, never blank the live one. `handlePostSearchResult`
    // sets this ref the moment the search returns, but a scored run does not
    // commit the token to node data until it finishes — so the old
    // `data.jobRunId || null` re-ran on the next state change (hubState →
    // 'scoring', gatheredCount update) and erased it mid-run. That left
    // `resetRunId` resolving to null, so Cancel during scoring discarded no
    // batch and orphaned the run's manifest/staging sidecars on disk — the exact
    // failure fixtures-canvas.js guards for. Every path that must clear the
    // token (resetHandler, handleRerun, handleClearCareerFiles, runPipeline's
    // start) assigns this ref explicitly, so nothing relies on it clearing here.
    if (data.jobRunId) jobRunIdRef.current = data.jobRunId;
  }, [data.scrapeWarnings, data.hubState, data.pendingJobs, data.gatheredCount, data.jobRunId]);

  useEffect(() => {
    careerClearWatermarkRef.current = normalizeJobAnalysisClearWatermark(data.jobAnalysisClearedAt);
  }, [data.jobAnalysisClearedAt]);

  // Per-source progress state populated by backend `job-source-progress`
  // events. Reset via `resetSourceProgress` before each fresh run so stale
  // counts from the previous run don't bleed into the new pipeline.
  const {
    progress: sourceProgress,
    lastActive: lastActiveSource,
    reset: resetSourceProgress,
  } = useSourceProgress(window.electronAPI?.onJobSourceProgress, id, {
    tokenAware: true,
    rejectReceipt: data._boardRollbackSourceProgressFence || null,
  });

  // Live AI-scoring progress (real-time path). The backend emits `scoring-progress`
  // before/during every score attempt and once per completed batch; we surface a
  // determinate "N / M" counter plus in-flight batch context in the 'scoring'
  // state. Filtered by nodeId so concurrent hubs don't cross-update each other.
  // Cleared to null at each scoring-phase entry (see the scoreJobs call sites) so a
  // finished run's final count never lingers; the render gate (hubState==='scoring')
  // also hides it outside the scoring phase.
  const [scoringProgress, setScoringProgress] = useState(null);
  useEffect(() => {
    if (!window.electronAPI?.onScoringProgress) return undefined;
    return window.electronAPI.onScoringProgress((payload) => {
      if (payload?.nodeId && payload.nodeId !== id) return;
      setScoringProgress({
        scored: payload.scored ?? 0,
        total: payload.total ?? 0,
        batch: payload.batch ?? null,
        batchTotal: payload.batchTotal ?? null,
        phase: payload.phase || null,
        attemptSize: payload.attemptSize ?? null,
        detail: payload.detail || null,
      });
    });
  }, [id]);

  const scheduleCleanSourceCardDismiss = useCallback((reason = 'all-sources-terminal') => {
    if (sourceDismissTimerRef.current) return;
    sourceDismissTimerRef.current = setTimeout(() => {
      sourceDismissTimerRef.current = null;
      document.dispatchEvent(new CustomEvent('job-source-dismiss-clean', {
        detail: { hubId: id, reason },
      }));
    }, SOURCE_CARD_DISMISS_GRACE_MS);
  }, [id]);

  const cancelCleanSourceCardDismiss = useCallback(() => {
    if (!sourceDismissTimerRef.current) return;
    clearTimeout(sourceDismissTimerRef.current);
    sourceDismissTimerRef.current = null;
  }, []);

  useEffect(() => {
    const hasGatingWarning = (data.scrapeWarnings || []).some(isJobSourceWarningGating);
    if (hubState === 'sources-ready' || hasGatingWarning) {
      cancelCleanSourceCardDismiss();
      return;
    }
    const sourceCards = getNodes().filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id);
    if (sourceCards.length === 0) {
      cancelCleanSourceCardDismiss();
      return;
    }

    const allVisibleCardsTerminal = sourceCards.every(node => {
      const live = sourceProgress[node.data?.sourceId];
      const persisted = node.data?.persistedProgress;
      const persistedCleanTerminal =
        (persisted?.status === 'done' || persisted?.status === 'skipped') && !persisted.warning;
      const effective = live?.status === 'searching'
        ? live
        : persistedCleanTerminal
          ? persisted
          : (live || persisted);
      return !!effective && isTerminalSourceStatus(effective.status);
    });

    if (allVisibleCardsTerminal) {
      scheduleCleanSourceCardDismiss();
    } else {
      cancelCleanSourceCardDismiss();
    }
  }, [sourceProgress, hubState, data.scrapeWarnings, id, getNodes, scheduleCleanSourceCardDismiss, cancelCleanSourceCardDismiss]);

  const retireManualAiRunDurably = useCallback(async (runId) => {
    if (!runId) return true;
    if (!window.electronAPI?.completeNonApiAiRun) {
      throw new Error('Durable manual-AI cleanup is unavailable.');
    }
    const result = await window.electronAPI.completeNonApiAiRun(runId);
    if (result?.cleared !== true && result?.absent !== true) {
      throw new Error('The saved manual-AI handoff could not be retired.');
    }
    if (activeManualAiRunIdRef.current === runId) activeManualAiRunIdRef.current = null;
    return true;
  }, []);

  const settleManualAiRetirement = useCallback(async ({
    runId,
    marker = null,
    retirementReason = 'cleanup',
    requireCancellationAck = false,
    cancellationReason = retirementReason,
    superseded = false,
    acknowledgedRunIds = null,
    beforeRetirement = null,
  } = {}) => {
    if (!runId) return true;
    const cancellationWasPreAcknowledged = Array.isArray(acknowledgedRunIds);
    let cancellationAcknowledged = cancellationWasPreAcknowledged || !requireCancellationAck;
    const runIds = new Set([
      runId,
      ...(cancellationWasPreAcknowledged ? acknowledgedRunIds : []),
    ].filter(Boolean));
    let acknowledgementError = null;
    if (requireCancellationAck && !cancellationWasPreAcknowledged) {
      attemptedManualAiCleanupRunIdsRef.current.add(runId);
      updateGlobal(id, (node) => {
        const liveMarker = node?.data?.manualAiResume || null;
        const existingReceipts = normalizeManualAiCleanupReceipts(
          node?.data?.manualAiCleanupReceipts,
        );
        const sameRunDescriptor = liveMarker?.runId === runId
          ? liveMarker
          : existingReceipts.find(receipt => receipt.runId === runId)
            || (marker?.runId === runId ? marker : {});
        const cancellationReceipt = {
          ...sameRunDescriptor,
          runId,
          retirementPending: true,
          retirementReason,
          cancellationPending: true,
          cancellationReason,
          updatedAt: Date.now(),
        };
        if (liveMarker?.runId === runId || (!liveMarker && !superseded)) {
          return {
            manualAiResume: cancellationReceipt,
            manualAiCleanupReceipts: removeManualAiCleanupReceipt(
              existingReceipts,
              runId,
            ),
          };
        }
        return {
          manualAiCleanupReceipts: upsertManualAiCleanupReceipt(
            existingReceipts,
            cancellationReceipt,
          ),
        };
      });
      let cancellationIntentCommitted = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await waitForRendererCommitFrame();
        const liveData = getNode(id)?.data || {};
        const liveMarker = liveData.manualAiResume;
        const cleanupReceipt = normalizeManualAiCleanupReceipts(
          liveData.manualAiCleanupReceipts,
        ).find(receipt => receipt.runId === runId);
        cancellationIntentCommitted = (
          (liveMarker?.runId === runId && liveMarker.cancellationPending === true)
          || cleanupReceipt?.cancellationPending === true
        );
        if (cancellationIntentCommitted) break;
      }
      if (!cancellationIntentCommitted) {
        throw new Error('The Job Search cancellation intent was not committed before task cancellation.');
      }
      try {
        if (!window.electronAPI?.cancelNodeTaskAndWait) {
          window.electronAPI?.cancelNodeTask?.(id, cancellationReason);
          throw new Error('Acknowledged Job Search cancellation is unavailable.');
        }
        const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(
          id,
          cancellationReason,
        );
        if (acknowledgement?.settled !== true) {
          throw new Error('The Job Search did not finish cancelling before the safety timeout.');
        }
        cancellationAcknowledged = true;
        for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || []) {
          if (acknowledgedRunId) runIds.add(acknowledgedRunId);
        }
      } catch (error) {
        acknowledgementError = error;
      }
    }

    if (
      !acknowledgementError
      && cancellationAcknowledged
      && (requireCancellationAck || cancellationWasPreAcknowledged)
    ) {
      const acknowledgedRunIds = [...runIds];
      for (const acknowledgedRunId of acknowledgedRunIds) {
        attemptedManualAiCleanupRunIdsRef.current.add(acknowledgedRunId);
      }
      updateGlobal(id, (node) => {
        let nextMarker = node?.data?.manualAiResume || null;
        let nextReceipts = normalizeManualAiCleanupReceipts(
          node?.data?.manualAiCleanupReceipts,
        );
        for (const acknowledgedRunId of acknowledgedRunIds) {
          const existingDescriptor = nextMarker?.runId === acknowledgedRunId
            ? nextMarker
            : nextReceipts.find(receipt => receipt.runId === acknowledgedRunId)
              || (marker?.runId === acknowledgedRunId ? marker : {});
          const durableReceipt = {
            ...existingDescriptor,
            runId: acknowledgedRunId,
            retirementPending: true,
            retirementReason,
            cancellationPending: false,
            cancellationReason,
            updatedAt: Date.now(),
          };
          if (nextMarker?.runId === acknowledgedRunId) {
            nextMarker = durableReceipt;
            nextReceipts = removeManualAiCleanupReceipt(nextReceipts, acknowledgedRunId);
          } else {
            nextReceipts = upsertManualAiCleanupReceipt(nextReceipts, durableReceipt);
          }
        }
        return {
          manualAiResume: nextMarker,
          manualAiCleanupReceipts: nextReceipts.length > 0 ? nextReceipts : null,
        };
      });
      let receiptsCommitted = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await waitForRendererCommitFrame();
        const liveData = getNode(id)?.data || {};
        const liveMarker = liveData.manualAiResume;
        const cleanupReceipts = normalizeManualAiCleanupReceipts(
          liveData.manualAiCleanupReceipts,
        );
        receiptsCommitted = acknowledgedRunIds.every(acknowledgedRunId => (
          (liveMarker?.runId === acknowledgedRunId && liveMarker.retirementPending)
          || cleanupReceipts.some(receipt => (
            receipt.runId === acknowledgedRunId && receipt.retirementPending
          ))
        ));
        if (receiptsCommitted) break;
      }
      if (!receiptsCommitted) {
        acknowledgementError = new Error(
          'The acknowledged manual-AI cleanup receipts were not committed to the canvas.',
        );
      }
    }

    // Some parents carry their own recovery receipt (for example a Job Board
    // child-cancellation plan). Let that owner commit the same acknowledged id
    // set after the Search receipts are durable but before external completion.
    if (!acknowledgementError && typeof beforeRetirement === 'function') {
      try {
        await beforeRetirement([...runIds]);
      } catch (error) {
        acknowledgementError = error;
      }
    }

    const retirementResults = acknowledgementError
      ? [...runIds].map(retirementRunId => ({
          runId: retirementRunId,
          status: 'rejected',
          reason: acknowledgementError,
        }))
      : await Promise.all([...runIds].map(async (retirementRunId) => {
          try {
            await retireManualAiRunDurably(retirementRunId);
            return { runId: retirementRunId, status: 'fulfilled' };
          } catch (error) {
            return { runId: retirementRunId, status: 'rejected', reason: error };
          }
        }));
    const successfulRunIds = new Set(
      retirementResults.filter(result => result.status === 'fulfilled').map(result => result.runId),
    );
    const failedResults = retirementResults.filter(result => result.status === 'rejected');
    for (const retiredRunId of successfulRunIds) {
      rememberBoundedRunId(cancelledBoardManualAiRunIdsRef.current, retiredRunId);
      if (activeManualAiRunIdRef.current === retiredRunId) activeManualAiRunIdRef.current = null;
    }
    for (const failed of failedResults) {
      if (activeManualAiRunIdRef.current === failed.runId) activeManualAiRunIdRef.current = null;
      const cleanupError = failed.reason?.message || 'Saved manual-AI cleanup did not finish.';
      manualAiCleanupErrorMessagesRef.current.add(cleanupError);
    }
    while (manualAiCleanupErrorMessagesRef.current.size > 64) {
      manualAiCleanupErrorMessagesRef.current.delete(
        manualAiCleanupErrorMessagesRef.current.values().next().value,
      );
    }

    updateGlobal(id, (node) => {
      const liveMarker = node?.data?.manualAiResume || null;
      const existingReceipts = normalizeManualAiCleanupReceipts(
        node?.data?.manualAiCleanupReceipts,
      );
      const descriptorByRunId = new Map(existingReceipts.map(receipt => [receipt.runId, receipt]));
      if (liveMarker?.runId) descriptorByRunId.set(liveMarker.runId, liveMarker);
      if (marker?.runId && !descriptorByRunId.has(marker.runId)) {
        descriptorByRunId.set(marker.runId, marker);
      }

      let nextMarker = liveMarker;
      let nextReceipts = existingReceipts;
      const retiredCleanupErrors = [];
      for (const retiredRunId of successfulRunIds) {
        const descriptor = descriptorByRunId.get(retiredRunId);
        if (descriptor?.cleanupError) retiredCleanupErrors.push(descriptor.cleanupError);
        nextReceipts = removeManualAiCleanupReceipt(nextReceipts, retiredRunId);
        if (nextMarker?.runId === retiredRunId) nextMarker = null;
      }
      for (const failed of failedResults) {
        const failedRunId = failed.runId;
        const sameRunDescriptor = descriptorByRunId.get(failedRunId)
          || (failedRunId === runId ? marker : null)
          || {};
        const cleanupError = failed.reason?.message || 'Saved manual-AI cleanup did not finish.';
        const retryReceipt = {
          ...sameRunDescriptor,
          runId: failedRunId,
          retirementPending: true,
          retirementReason,
          cancellationPending: !cancellationAcknowledged,
          ...(requireCancellationAck || sameRunDescriptor.cancellationReason
            ? { cancellationReason }
            : {}),
          cleanupError,
          updatedAt: Date.now(),
        };
        const keepsPrimaryMarker = failedRunId === runId && !superseded;
        if (nextMarker?.runId === failedRunId || (!nextMarker && keepsPrimaryMarker)) {
          nextMarker = retryReceipt;
          nextReceipts = removeManualAiCleanupReceipt(nextReceipts, failedRunId);
        } else {
          nextReceipts = upsertManualAiCleanupReceipt(nextReceipts, retryReceipt);
        }
      }

      const hasPendingCleanup = nextReceipts.length > 0 || !!nextMarker?.retirementPending;
      const clearsCleanupError = !hasPendingCleanup
        && (
          retiredCleanupErrors.some(cleanupError => node?.data?.errorMessage === cleanupError)
          || manualAiCleanupErrorMessagesRef.current.has(node?.data?.errorMessage)
        );
      const primaryFailure = failedResults.find(result => result.runId === runId);
      const surfacesPrimaryFailure = !!primaryFailure && !superseded
        && (!liveMarker?.runId || liveMarker.runId === runId);
      return {
        manualAiResume: nextMarker,
        manualAiCleanupReceipts: nextReceipts.length > 0 ? nextReceipts : null,
        ...(clearsCleanupError ? { errorMessage: null } : {}),
        ...(surfacesPrimaryFailure ? {
          errorMessage: primaryFailure.reason?.message || 'Saved manual-AI cleanup did not finish.',
        } : {}),
      };
    });

    // Do not release queue/cancellation ownership until every successfully
    // retired id is absent and every failed id has its own durable retry receipt.
    let reconciliationCommitted = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForRendererCommitFrame();
      if (!getNode(id)) {
        reconciliationCommitted = true;
        break;
      }
      const liveData = getNode(id)?.data || {};
      const liveMarker = liveData.manualAiResume;
      const cleanupReceipts = normalizeManualAiCleanupReceipts(
        liveData.manualAiCleanupReceipts,
      );
      const successesCommitted = [...successfulRunIds].every(retiredRunId => (
        liveMarker?.runId !== retiredRunId
        && !cleanupReceipts.some(receipt => receipt.runId === retiredRunId)
      ));
      const failuresCommitted = failedResults.every(failed => (
        (liveMarker?.runId === failed.runId && liveMarker.retirementPending)
        || cleanupReceipts.some(receipt => (
          receipt.runId === failed.runId && receipt.retirementPending
        ))
      ));
      if (successesCommitted && failuresCommitted) {
        reconciliationCommitted = true;
        break;
      }
    }
    if (!reconciliationCommitted) {
      throw new Error('The manual-AI cleanup result was not committed to the canvas.');
    }
    if (failedResults.length > 0) throw failedResults[0].reason;
    return true;
  }, [getNode, id, retireManualAiRunDurably, updateGlobal]);

  const completeManualAiRun = useCallback(async (runId, {
    retirementReason = 'workflow-completed',
  } = {}) => {
    if (!runId) return true;

    // Capture ownership synchronously. The Board runner may clear its in-memory
    // control before the disk acknowledgement settles, and a pending event may
    // not have published the renderer marker yet.
    const markerAtCompletion = getNode(id)?.data?.manualAiResume;
    const boardControl = boardRunControlRef.current;
    const ownerAtCompletion = boardControl?.manualAiRunId === runId
      ? {
          orchestratorNodeId: boardControl.orchestratorNodeId,
          boardRunId: boardControl.boardRunId,
        }
      : markerAtCompletion?.runId === runId
        ? {
            ...(markerAtCompletion.orchestratorNodeId
              ? { orchestratorNodeId: markerAtCompletion.orchestratorNodeId }
              : {}),
            ...(markerAtCompletion.boardRunId
              ? { boardRunId: markerAtCompletion.boardRunId }
              : {}),
          }
        : {};

    const capturedMarker = {
      ...(markerAtCompletion?.runId === runId ? markerAtCompletion : {}),
      ...ownerAtCompletion,
      runId,
    };

    // Catch here as well as awaiting at each transaction boundary so terminal
    // callers can finish with a durable cleanup receipt instead of turning a
    // housekeeping failure into a second workflow failure.
    try {
      return await settleManualAiRetirement({
        runId,
        marker: capturedMarker,
        retirementReason,
      });
    } catch (error) {
      EventLogger.error(`[JobSearch][${id}] Durable manual-AI completion failed:`, error);
      return false;
    }
  }, [getNode, id, settleManualAiRetirement]);

  // This sits above the late-USAJobs callback because hooks evaluate their
  // dependency arrays during render. Keeping it below that callback made the
  // callback's `[... evaluatePreferencesForRun]` dependency read this `const`
  // while it was still in its temporal dead zone, crashing every fresh hub.
  const evaluatePreferencesForRun = useCallback(async ({
    jobs, profile, careerData, activeTargetRole, activeJobPreferences,
    jobPreferencesInterpretation, locationSnapshot, manualAiRunId,
    manualAiRecoveryMode = null,
  }) => {
    const fallbackJobs = Array.isArray(jobs) ? jobs : [];
    if (!activeJobPreferences) {
      return { jobs: fallbackJobs, candidatePool: fallbackJobs, matchedCount: null, filteredCount: null, evaluation: null };
    }
    // Older main processes do not expose this IPC yet. Keep their existing
    // search behavior rather than pretending a preference was verified.
    if (!window.electronAPI?.evaluateJobPreferences) {
      return { jobs: fallbackJobs, candidatePool: fallbackJobs, matchedCount: null, filteredCount: null, evaluation: null };
    }
    updateGlobal(id, { hubState: 'evaluating-preferences', jobCount: fallbackJobs.length });
    const result = await window.electronAPI.evaluateJobPreferences({
      jobs: fallbackJobs,
      profile,
      careerData,
      nodeId: id,
      manualAiRunId,
      manualAiRecoveryMode,
      targetRole: activeTargetRole,
      jobPreferences: activeJobPreferences,
      jobPreferencePlan: jobPreferencesInterpretation,
      preferencePlan: jobPreferencesInterpretation,
      jobPreferencesInterpretation,
      searchLocation: locationSnapshot?.searchLocation || null,
      remoteResidences: locationSnapshot?.remoteResidences || null,
    });
    if (result?.success === false) {
      const error = new Error(result.error || 'Failed to evaluate Job Preferences');
      throw error;
    }
    return normalizePreferenceEvaluation(result, fallbackJobs);
  }, [id, updateGlobal]);

  // Background-streamed scored jobs (the late USAJobs refresh) used to spawn cards
  // straight into the done canvas. Now the Job Search Module only STORES its
  // scored jobs — a connected Job Board Module does the display — so this merges
  // the fresh set into data.scoredJobs (deduped) and updates the summary counts.
  // The board picks them up on its next Combine / Re-combine.
  const appendJobsToDoneCanvas = useCallback(async ({
    scoredJobs, filteredWarnings, gatheredDelta = 0,
    preferenceMatchedDelta = null, preferenceFilteredDelta = null,
    preferenceEvaluation = null, preferenceCandidatePool = null,
    baseData = null,
    emptyResultDisposition = 'incomplete',
    canCommit = () => true,
  }) => {
    if (!baseData || !canCommit()) return false;
    const fresh = Array.isArray(scoredJobs) ? scoredJobs : [];
    const existing = Array.isArray(baseData.scoredJobs) ? baseData.scoredJobs : [];
    const added = uniqueJobsAcrossSources(existing, fresh);
    const nextScored = added.length ? [...existing, ...added] : existing;

    const finalSourceCounts = { ...baseData.finalSourceCounts };
    added.forEach(job => { finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1; });

    const allScores = nextScored.map(j => j.matchScore || 0);
    const scoreRangeMin = allScores.length ? Math.min(...allScores) : (baseData.scoreRangeMin ?? 0);
    const scoreRangeMax = allScores.length ? Math.max(...allScores) : (baseData.scoreRangeMax ?? 100);
    // Same rule as finishScoringAndSpawn: an append made with no preferences in
    // effect must not recreate the redundant pool that path deliberately skips.
    const appendRanPreferences = preferenceMatchedDelta != null || preferenceFilteredDelta != null;
    const combinedPreferenceCandidatePool = (appendRanPreferences && Array.isArray(preferenceCandidatePool))
      ? mergePreferenceCandidatePools(baseData.preferenceCandidatePool, preferenceCandidatePool)
      : baseData.preferenceCandidatePool ?? null;
    const combinedPreferenceEvaluation = preferenceEvaluation
      ? mergePreferenceEvaluations(baseData.preferenceEvaluation, preferenceEvaluation)
      : baseData.preferenceEvaluation ?? null;

    const appendPatch = {
      hubState: 'done',
      scoredJobs: nextScored,
      resultCount: nextScored.length,
      totalScoredCount: nextScored.length,
      // Keep the "scraped → kept" funnel in sync after a background append.
      gatheredCount: (baseData.gatheredCount || 0) + gatheredDelta,
      scrapedCount: (baseData.scrapedCount || 0) + added.length,
      preferenceMatchedCount: preferenceMatchedDelta == null
        ? baseData.preferenceMatchedCount ?? null
        : (Number(baseData.preferenceMatchedCount) || 0) + preferenceMatchedDelta,
      preferenceFilteredCount: preferenceFilteredDelta == null
        ? baseData.preferenceFilteredCount ?? null
        : (Number(baseData.preferenceFilteredCount) || 0) + preferenceFilteredDelta,
      preferenceEvaluation: combinedPreferenceEvaluation,
      preferenceCandidatePool: combinedPreferenceCandidatePool,
      finalSourceCounts,
      scoreRangeMin,
      scoreRangeMax,
      scrapeWarnings: Array.isArray(filteredWarnings) ? filteredWarnings : (baseData.scrapeWarnings || []),
      resultDisposition: nextScored.length > 0 ? 'scored' : emptyResultDisposition,
      // A background refresh can add jobs after a zero-result run, so the
      // headline returns to the normal scored-jobs summary immediately.
      rerunOutcome: null,
      rerunNotice: null,
    };
    let functionalCommitAccepted = false;
    const updateAccepted = updateGlobal(id, () => {
      if (!canCommit()) return null;
      functionalCommitAccepted = true;
      return appendPatch;
    });
    if (updateAccepted === false) return false;

    // Global navigation updates are scheduled through React. Do not report a
    // successful append (or retire its manual-AI handoff) until the functional
    // generation guard actually ran and the intended result is observable.
    await waitForRendererCommitFrame();
    const committed = getNode(id)?.data;
    if (!functionalCommitAccepted || !committed) return false;
    const equivalent = (actual, expected) => {
      if (Object.is(actual, expected)) return true;
      if (actual == null || expected == null) return false;
      if (typeof actual !== 'object' || typeof expected !== 'object') return false;
      try {
        return JSON.stringify(actual) === JSON.stringify(expected);
      } catch {
        return false;
      }
    };
    return Object.entries(appendPatch).every(([key, expected]) => (
      equivalent(committed[key], expected)
    ));
  }, [getNode, id, updateGlobal]);

  const triggerUSAJobsBackgroundSearch = useCallback(async () => {
    if (isJobWorkflowDeletionPending(id)) {
      pendingUSAJobsRefreshRef.current = true;
      return;
    }
    if (processingRunsRef.current.active) return;
    const currentId = id;
    const boardConnectionOwnsRefresh = () => isJobSearchConnectedToBoard(
      currentId,
      getNodes(),
      getEdges(),
    );
    const clearOwnQueueMarker = () => updateGlobal(currentId, (node) => (
      node?.data?.queuedModuleRun?.label === 'Refreshing USAJobs'
        ? { queuedModuleRun: null }
        : null
    ));
    // This refresh is a new provider/scoring transaction, not cleanup for the
    // already-committed generation. Once a Board is connected it owns every new
    // search admission, including this automatic credentials-change retry.
    if (boardConnectionOwnsRefresh()) {
      pendingUSAJobsRefreshRef.current = false;
      clearOwnQueueMarker();
      EventLogger.log(
        `[JobSearch][${id}] USAJobs background search dropped because a connected Job Board owns search admission.`,
      );
      return;
    }
    const recoveryReservation = () => {
      const liveNode = getNode(currentId);
      if (
        !liveNode
        || liveNode.data?.terminalFinalizationRecovery
        || liveNode.data?.manualAiResume?.runId
        || hasPendingManualAiRetirement(liveNode.data)
      ) return true;
      return !!findJobSearchBoardActiveRecoveryOwner(
        currentId,
        getNodes(),
        getEdges(),
      );
    };
    if (recoveryReservation()) {
      pendingUSAJobsRefreshRef.current = true;
      EventLogger.log(`[JobSearch][${id}] USAJobs background search skipped because durable recovery owns this module.`);
      return;
    }
    if (!isJobSourceEnabledInScope('usajobs') || !activeEnabledSourceIds.includes('usajobs')) {
      pendingUSAJobsRefreshRef.current = false;
      EventLogger.log(`[JobSearch][${id}] USAJobs background search skipped because its platform is disabled.`);
      return;
    }
    // A queued refresh reads live credentials/settings only after its lane turn,
    // so repeated settings events can coalesce into that exact admission. Work
    // that is not this refresh (saved scoring, re-analysis, etc.) cannot absorb
    // the provider retry; preserve the latch until that workflow releases.
    if (usaJobsRefreshAdmissionRef.current) {
      pendingUSAJobsRefreshRef.current = false;
      EventLogger.log(`[JobSearch][${id}] Duplicate USAJobs background search coalesced into its queued refresh.`);
      return;
    }
    if (localQueueAdmissionRef.current) {
      pendingUSAJobsRefreshRef.current = true;
      EventLogger.log(`[JobSearch][${id}] USAJobs background search deferred behind existing Search work.`);
      return;
    }
    const admissionToken = Symbol(`usajobs-refresh:${currentId}`);
    usaJobsRefreshAdmissionRef.current = admissionToken;
    localQueueAdmissionRef.current = admissionToken;
    // Consume the admitted intent before it enters the queue. A later settings
    // event can set a new intent while this turn waits or runs; a recovery
    // reservation discovered at queue start explicitly re-latches it.
    pendingUSAJobsRefreshRef.current = false;
    const cancelled = epoch.start();
    // A late USAJobs append can still reach the same manual-AI handoff as a
    // foreground search. It needs one durable identity across preferences and
    // scoring, and must own the shared job lane before either can begin.
    const manualAiRunId = createManualAiRunId(currentId);
    let lease = null;
    let processingToken = null;
    let refreshClaimedByBoard = false;
    let refreshData = null;
    let refreshGenerationRunId = null;
    let refreshGenerationFingerprint = null;
    let refreshGenerationDisposition = null;
    const canCommitRefresh = () => {
      // Recovery created after this refresh acquired the FIFO lane is a waiter,
      // not authority to revoke the current owner mid-transaction. It will
      // revalidate against the committed generation when its own turn starts.
      if (cancelled()) return false;
      const liveData = getNode(currentId)?.data;
      return !!liveData
        && (liveData.jobRunId || null) === refreshGenerationRunId
        && (liveData.resultDisposition || null) === refreshGenerationDisposition
        && moduleFingerprint(liveData.scoredJobs) === refreshGenerationFingerprint;
    };

    try {
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: currentId,
        kind: 'jobsearch',
        lane: 'job-search',
        label: 'Refresh USAJobs',
        onQueued: ({ position }) => {
          updateGlobal(currentId, {
            queuedModuleRun: { label: 'Refreshing USAJobs', position },
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(currentId, { queuedModuleRun: { label: 'Refreshing USAJobs', position } });
        },
        onStart: () => {
          if (cancelled() || isJobWorkflowDeletionPending(currentId)) throw new Error('Node deleted');
          if (boardConnectionOwnsRefresh()) {
            refreshClaimedByBoard = true;
            return;
          }
          clearOwnQueueMarker();
        },
      });
      if (refreshClaimedByBoard) {
        pendingUSAJobsRefreshRef.current = false;
        clearOwnQueueMarker();
        EventLogger.log(
          `[JobSearch][${id}] Queued USAJobs background search dropped because a connected Job Board now owns search admission.`,
        );
        return;
      }
      if (isJobWorkflowDeletionPending(currentId)) {
        pendingUSAJobsRefreshRef.current = true;
        EventLogger.log(`[JobSearch][${id}] USAJobs background search deferred while deletion is pending.`);
        return;
      }
      if (cancelled() || recoveryReservation()) {
        pendingUSAJobsRefreshRef.current = !cancelled();
        EventLogger.log(`[JobSearch][${id}] USAJobs background search yielded to durable recovery at queue start.`);
        return;
      }
      refreshData = getNode(currentId)?.data || null;
      const refreshEnabledSourceIds = normalizeEnabledJobSourceIds(refreshData?.enabledSourceIds);
      const refreshCollectionLimits = normalizeJobCollectionLimits(refreshData?.collectionLimits);
      const refreshRunnableSources = getRunnableJobSourceIds(
        refreshEnabledSourceIds,
        ACTIVE_JOB_SOURCES,
        refreshCollectionLimits,
      );
      if (!refreshData || !refreshRunnableSources.includes('usajobs')) {
        EventLogger.log(`[JobSearch][${id}] USAJobs background search skipped because its live platform selection changed.`);
        return;
      }
      if (refreshData.hubState !== 'done' && refreshData.hubState !== 'sources-ready') {
        EventLogger.log(`[JobSearch][${id}] USAJobs background search skipped because the live search is not appendable.`);
        return;
      }
      const query = flattenJobSearchQueries(refreshData.queries)[0] || '';
      if (!query) {
        EventLogger.log(`[JobSearch][${id}] No stored queries found to run USAJobs background search.`);
        return;
      }
      processingToken = processingRunsRef.current.start();
      if (!processingToken) return;
      // Publish ownership before any await that can enter the manual-AI path.
      // Reset can now perform acknowledged cancellation even if the global
      // pending event has not reached this node yet.
      activeManualAiRunIdRef.current = manualAiRunId;
      refreshGenerationRunId = refreshData.jobRunId || null;
      refreshGenerationFingerprint = moduleFingerprint(refreshData.scoredJobs);
      refreshGenerationDisposition = refreshData.resultDisposition || null;
      EventLogger.log(`[JobSearch][${id}] Starting USAJobs background search for query: "${query}"`);

      const res = await window.electronAPI.searchJobsSingleSource({
        query,
        sourceId: 'usajobs',
        // Use the post-queue live snapshot rather than the render that scheduled
        // this refresh; a foreground/Board run may have finished while it waited.
        maxAgeDays: refreshData.maxAgeDays || 21,
        collectionLimits: refreshCollectionLimits,
        enabledSourceIds: refreshEnabledSourceIds,
        canvasFilePath,
        nodeId: currentId,
        // Background USAJobs is part of the completed search generation; its
        // tagged progress must survive the JobSearch token-aware guard.
        jobRunId: refreshGenerationRunId,
        // Prefer the query-gen-normalized location (typo-safe) over the raw input
        // — USAJobs LocationName is an exact-ish match and won't tolerate "denvr".
        preferredLocation: (refreshData.canonicalLocation || refreshData.preferredLocation || '').trim(),
        // `targetRole` is legacy-only data — an unmigrated canvas's
        // standalone Target role box — sent for back-compat so USAJobs still
        // searches exactly that one string. This late source belongs to the
        // completed search generation, so this reads the frozen refreshData
        // snapshot, never the live/editable hub value (which may already
        // describe the *next* run). There is no post-search title gate
        // anymore (see deriveSearchTitles above and the removed
        // applyPinnedTitleGate in jobs.js) — role relevance for this source's
        // rows is judged the same way as every other source's: the AI role
        // screen inside per-listing preference evaluation.
        targetRole: (refreshData.activeTargetRole ?? refreshData.targetRole ?? '').trim(),
        jobPreferences: refreshData.activeJobPreferences ?? refreshData.jobPreferences ?? '',
        preferencePlan: refreshData.jobPreferencePlan ?? refreshData.jobPreferencesInterpretation ?? null,
      });

      if (!canCommitRefresh()) {
        EventLogger.log(`[JobSearch][${id}] USAJobs background result ignored because its owning generation changed.`);
        return;
      }

      if (!res.success) {
        throw new Error(res.error || 'Failed to search USAJobs');
      }

      const freshJobs = res.jobs || [];
      const newWarning = res.warning || null;
      const filteredWarnings = (scrapeWarningsRef.current || []).filter(
        w => w.sourceId !== 'usajobs'
      );
      if (newWarning) {
        filteredWarnings.push({ sourceId: 'usajobs', ...newWarning });
      }

      const currentState = refreshData.hubState;

      if (currentState === 'sources-ready') {
        const prevPending = Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current : [];
        const fresh = uniqueJobsAcrossSources(prevPending, freshJobs);
        const mergedPending = [...prevPending, ...fresh];
        // This source completed after the main search paused. Its collected
        // volume belongs in the funnel even when every returned row collapses
        // against another source before scoring.
        gatheredCountRef.current = Math.max(
          0,
          (Number(gatheredCountRef.current) || 0) + freshJobs.length,
        );
        pendingJobsRef.current = mergedPending;
        scrapeWarningsRef.current = filteredWarnings;
        updateGlobal(currentId, {
          pendingJobs: mergedPending,
          jobCount: mergedPending.length,
          gatheredCount: gatheredCountRef.current,
          scrapeWarnings: filteredWarnings,
        });

        const remainingBlocks = filteredWarnings.filter(isJobSourceWarningGating);
        // No pending-length gate: a paused run that collected nothing must still
        // resume, exactly as the Skip/resolve handlers do. resumeScoring's empty
        // branch finishes it in 'done' rather than stranding it in a
        // 'sources-ready' screen with no remaining blocks and no action.
        if (remainingBlocks.length === 0) {
          EventLogger.log(`[JobSearch][${id}] Auto-resuming scoring from sources-ready state.`);
          // resumeScoring acquires this lane itself. Drop both this lane lease
          // and this processing token before handing off, so it cannot wait on
          // its own still-held lease or see the background pass as active.
          await waitForRendererCommitFrame();
          if (cancelled()) return;
          lease?.release();
          lease = null;
          if (isMountedRef.current && processingRunsRef.current.finish(processingToken)) {
            pendingUSAJobsRefreshRef.current = false;
            await resumeScoringRef.current?.();
          }
          return;
        }
      } else if (currentState === 'done') {
        if (freshJobs.length > 0) {
          setScoringProgress(null); // clear prior counter; backend re-paints "0 / M"
          updateGlobal(currentId, {
            hubState: 'scoring',
            scrapeWarnings: filteredWarnings,
          });

          const profile = refreshData.resumeProfile;
          const activeTargetRole = (refreshData.activeTargetRole ?? refreshData.targetRole ?? '').trim();
          const activeJobPreferences = refreshData.activeJobPreferences ?? refreshData.jobPreferences ?? '';
          const jobPreferencesInterpretation = refreshData.jobPreferencePlan ?? refreshData.jobPreferencesInterpretation ?? null;
          const locationSnapshot = refreshData.locationSnapshot || {
            searchLocation: getSearchLocation({
              searchLocation: refreshData.searchLocation,
              preferredLocation: refreshData.preferredLocation,
              canonicalLocation: refreshData.canonicalLocation,
            }),
            remoteResidences: normalizeRemoteResidences(refreshData.remoteResidences),
          };

          // The background source's raw volume belongs in the gathered funnel,
          // but preferences must only assess genuinely new listings. Otherwise
          // a duplicate USAJobs row can inflate matched/filtered counts and
          // append duplicate audit evidence after the candidate pool dedupes.
          const existingPreferencePool = Array.isArray(refreshData.preferenceCandidatePool)
            ? refreshData.preferenceCandidatePool
            : (Array.isArray(refreshData.scoredJobs) ? refreshData.scoredJobs : []);
          const newPreferenceCandidates = uniqueJobsAcrossSources(existingPreferencePool, freshJobs);
          if (newPreferenceCandidates.length === 0) {
            if (!canCommitRefresh()) return;
            updateGlobal(currentId, {
              hubState: 'done',
              scrapeWarnings: filteredWarnings,
              gatheredCount: (Number(refreshData.gatheredCount) || 0) + freshJobs.length,
            });
            return;
          }

          const preferenceResult = await evaluatePreferencesForRun({
            jobs: newPreferenceCandidates,
            profile,
            careerData: refreshData.careerData,
            activeTargetRole,
            activeJobPreferences,
            jobPreferencesInterpretation,
            locationSnapshot,
            manualAiRunId,
            manualAiRecoveryMode: 'append-scored-jobs',
          });
          if (!canCommitRefresh()) return;
          const combinedPreferenceCandidatePool = mergePreferenceCandidatePools(
            refreshData.preferenceCandidatePool,
            preferenceResult.candidatePool,
          );
          const combinedPreferenceEvaluation = mergePreferenceEvaluations(
            refreshData.preferenceEvaluation,
            preferenceResult.evaluation,
          );
          const combinedPreferenceMatchedCount = (Number(refreshData.preferenceMatchedCount) || 0)
            + (preferenceResult.matchedCount || 0);
          const combinedPreferenceFilteredCount = (Number(refreshData.preferenceFilteredCount) || 0)
            + (preferenceResult.filteredCount || 0);
          if (preferenceResult.jobs.length === 0) {
            // A background source can be the first source to find listings
            // after an authoritative empty. Persist its filtered candidate
            // pool before returning to done so a later preference edit can
            // re-evaluate it without another scrape.
            try {
              await window.electronAPI?.saveJobAnalysisSnapshot?.({
                jobs: combinedPreferenceCandidatePool,
                profile,
                careerData: refreshData.careerData,
                nodeId: currentId,
                targetRole: activeTargetRole,
                jobPreferences: activeJobPreferences,
                jobPreferencePlan: jobPreferencesInterpretation,
                preferenceEvaluation: combinedPreferenceEvaluation,
                preferenceCandidatePool: combinedPreferenceCandidatePool,
                snapshotContext: {
                  sourceHubId: currentId,
                  runId: refreshGenerationRunId,
                  canvasFilePath,
                  resumeSummary: buildResumeSummary(profile),
                  sourceGatheredCount: (Number(refreshData.gatheredCount) || 0) + freshJobs.length,
                  locationSnapshot,
                  searchLocation: locationSnapshot.searchLocation,
                  remoteResidences: locationSnapshot.remoteResidences,
                },
              });
            } catch (snapshotError) {
              EventLogger.error(`[JobSearch][${id}] Failed to save preference-filtered USAJobs snapshot:`, snapshotError);
            }
            if (!canCommitRefresh()) return;
            updateGlobal(currentId, {
              hubState: 'done',
              scrapeWarnings: filteredWarnings,
              // The late source was genuinely gathered even though every new
              // listing failed preferences. Keep the done funnel truthful.
              gatheredCount: (Number(refreshData.gatheredCount) || 0) + freshJobs.length,
              preferenceMatchedCount: combinedPreferenceMatchedCount,
              preferenceFilteredCount: combinedPreferenceFilteredCount,
              preferenceEvaluation: combinedPreferenceEvaluation,
              preferenceCandidatePool: combinedPreferenceCandidatePool,
              resultDisposition: (Array.isArray(refreshData.scoredJobs) && refreshData.scoredJobs.length > 0)
                ? 'scored'
                : 'preference-filtered',
            });
            await completeManualAiRun(manualAiRunId);
            return;
          }

          const scoreResult = await window.electronAPI.scoreJobs({
            jobs: preferenceResult.jobs,
            profile,
            careerData: refreshData.careerData,
            nodeId: currentId,
            manualAiRunId,
            manualAiRecoveryMode: 'append-scored-jobs',
            targetRole: activeTargetRole,
            jobPreferences: activeJobPreferences,
            jobPreferencePlan: jobPreferencesInterpretation,
            preferenceEvaluation: combinedPreferenceEvaluation,
            preferenceCandidatePool: combinedPreferenceCandidatePool,
            searchLocation: locationSnapshot.searchLocation,
            remoteResidences: locationSnapshot.remoteResidences,
            snapshotContext: {
              sourceHubId: currentId,
              runId: refreshGenerationRunId,
              canvasFilePath,
              resumeSummary: buildResumeSummary(profile),
              sourceGatheredCount: (Number(refreshData.gatheredCount) || 0) + freshJobs.length,
              searchLocation: locationSnapshot.searchLocation,
              remoteResidences: locationSnapshot.remoteResidences,
            },
          });

          if (!canCommitRefresh()) return;

          if (!scoreResult.success) {
            throw new Error(scoreResult.error || 'Failed to score background USAJobs');
          }

          // `scoreJobs` saves its own prompt snapshot, but this background pass
          // scores only the new USAJobs subset. Replace that transient subset
          // snapshot with the same deduped union the done state is about to
          // expose, so Saved Scrape recovery never drops previously visible
          // results after a late source refresh.
          const existingScoredJobs = Array.isArray(refreshData.scoredJobs) ? refreshData.scoredJobs : [];
          const freshScoredJobs = Array.isArray(scoreResult.scoredJobs) ? scoreResult.scoredJobs : [];
          const addedScoredJobs = uniqueJobsAcrossSources(existingScoredJobs, freshScoredJobs);
          const combinedScoredJobs = addedScoredJobs.length
            ? [...existingScoredJobs, ...addedScoredJobs]
            : existingScoredJobs;
          const aggregateSourceGatheredCount = (Number(refreshData.gatheredCount) || 0) + freshJobs.length;
          try {
            const saved = await window.electronAPI?.saveJobAnalysisSnapshot?.({
              jobs: combinedScoredJobs,
              profile,
              careerData: refreshData.careerData,
              nodeId: currentId,
              targetRole: activeTargetRole,
              jobPreferences: activeJobPreferences,
              jobPreferencePlan: jobPreferencesInterpretation,
              preferenceEvaluation: combinedPreferenceEvaluation,
              preferenceCandidatePool: combinedPreferenceCandidatePool,
              snapshotContext: {
                sourceHubId: currentId,
                runId: refreshGenerationRunId,
                canvasFilePath,
                resumeSummary: buildResumeSummary(profile),
                sourceGatheredCount: aggregateSourceGatheredCount,
                locationSnapshot,
                searchLocation: locationSnapshot.searchLocation,
                remoteResidences: locationSnapshot.remoteResidences,
                jobPreferences: activeJobPreferences,
                jobPreferencePlan: jobPreferencesInterpretation,
                preferenceCandidatePool: combinedPreferenceCandidatePool,
              },
            });
            if (saved && !saved.saved) {
              EventLogger.error(`[JobSearch][${id}] Failed to save combined USAJobs snapshot: ${saved.error || 'unknown error'}`);
            }
          } catch (snapshotError) {
            // The append itself is already valid; a local recovery snapshot
            // failure must not turn a successful background refresh into an error.
            EventLogger.error(`[JobSearch][${id}] Failed to save combined USAJobs snapshot:`, snapshotError);
          }

          const appendCommitted = await appendJobsToDoneCanvas({
            scoredJobs: scoreResult.scoredJobs,
            filteredWarnings,
            gatheredDelta: freshJobs.length,
            preferenceMatchedDelta: preferenceResult.matchedCount,
            preferenceFilteredDelta: preferenceResult.filteredCount,
            preferenceEvaluation: preferenceResult.evaluation,
            preferenceCandidatePool: preferenceResult.candidatePool,
            baseData: refreshData,
            canCommit: canCommitRefresh,
          });
          if (!appendCommitted) return;
          await completeManualAiRun(manualAiRunId);
        } else {
          if (!canCommitRefresh()) return;
          updateGlobal(currentId, {
            hubState: 'done',
            scrapeWarnings: filteredWarnings,
          });
        }
      }
    } catch (err) {
      if (isNodeDeletedAbort(err) || isJobWorkflowDeletionPending(currentId)) {
        // Deletion is reversible until cleanup succeeds. Keep the original
        // credentials-change intent so an aborted deletion wakes this refresh
        // through deletionLifecycleRevision instead of consuming it forever.
        pendingUSAJobsRefreshRef.current = true;
        return;
      }
      if (cancelled() || (refreshData && !canCommitRefresh())) return;
      EventLogger.error(`[JobSearch][${id}] USAJobs background search/integrate failed:`, err);
      addToast({
        title: 'USAJobs Refresh Failed',
        description: err?.message || String(err),
        type: 'error',
      });
      // Restore a terminal state from ANY transient processing state, not just
      // 'scoring'. This refresh also passes through 'evaluating-preferences',
      // and leaving the hub parked there is not merely cosmetic: every state in
      // TRANSIENT_PROCESSING_HUB_STATES is rewritten to 'empty' on save, so a
      // failed background append turned a hub that already held complete
      // results into an empty drop card on the next reload.
      const strandedState = getNode(currentId)?.data?.hubState || hubStateRef.current;
      const stranded = TRANSIENT_PROCESSING_HUB_STATES.includes(strandedState);
      updateGlobal(currentId, {
        hubState: stranded ? 'done' : strandedState,
        ...(stranded ? { resultDisposition: 'incomplete' } : {}),
        errorMessage: err?.message || String(err),
      });
    } finally {
      clearOwnQueueMarker();
      if (activeManualAiRunIdRef.current === manualAiRunId) {
        activeManualAiRunIdRef.current = null;
      }
      if (processingToken && isMountedRef.current && processingRunsRef.current.finish(processingToken)) {
        if (
          pendingUSAJobsRefreshRef.current
          && !isJobWorkflowDeletionPending(currentId)
        ) {
          pendingUSAJobsRefreshRef.current = false;
          setTimeout(() => {
            if (isMountedRef.current) void triggerUSAJobsBackgroundSearch();
          }, 0);
        }
      }
      if (localQueueAdmissionRef.current === admissionToken) {
        localQueueAdmissionRef.current = null;
      }
      if (usaJobsRefreshAdmissionRef.current === admissionToken) {
        usaJobsRefreshAdmissionRef.current = null;
      }
      if (lease) await waitForRendererCommitFrame();
      lease?.release();
    }
  }, [id, activeEnabledSourceIds, canvasFilePath, epoch, updateGlobal, addToast, appendJobsToDoneCanvas, completeManualAiRun, evaluatePreferencesForRun, isMountedRef, moduleRunQueue, getNode, getNodes, getEdges]);

  const handleJobsSettingsChange = useCallback(async () => {
    if (settingsDebounceTimerRef.current) {
      clearTimeout(settingsDebounceTimerRef.current);
    }
    settingsDebounceTimerRef.current = setTimeout(async () => {
      try {
        const settings = await window.electronAPI.getSettings();
        const usajobsKey = settings?.jobs?.usajobsApiKey;
        const usajobsEmail = settings?.jobs?.usajobsEmail;
        if (!usajobsKey || !usajobsEmail) {
          return;
        }

        const hasConfigOrApiWarning = (data.scrapeWarnings || []).some(
          w => w.sourceId === 'usajobs' && (
            w.code === 'config-missing' ||
            w.code === 'api-failed' ||
            w.code === 'scrape-failed'
          )
        );

        if (hasConfigOrApiWarning) {
          EventLogger.log(`[JobSearch][${id}] USAJobs credentials detected/updated. Refreshing USAJobs...`);
          if (processingRunsRef.current.active) {
            pendingUSAJobsRefreshRef.current = true;
            EventLogger.log(`[JobSearch][${id}] Pipeline is currently active. Queued USAJobs background refresh.`);
          } else {
            triggerUSAJobsBackgroundSearch();
          }
        }
      } catch (err) {
        EventLogger.error(`[JobSearch][${id}] Error handling jobs settings change:`, err);
      }
    }, 1000);
  }, [id, data.scrapeWarnings, triggerUSAJobsBackgroundSearch]);

  // React to settings changes (jobs section only — the 'ai' settings section
  // was deleted along with all live LLM HTTP API support, so no event can
  // ever carry it any more; the branch that used to log-only on 'ai' changes
  // was removed as unreachable).
  useEffect(() => {
    if (!window.electronAPI?.onSettingsChanged) return;
    const cleanup = window.electronAPI.onSettingsChanged((payload) => {
      if (payload?.changedSections?.includes('jobs')) {
        handleJobsSettingsChange();
      }
    });
    return () => cleanup?.();
  }, [handleJobsSettingsChange]);

  // A credentials change may arrive while a recovered Board owns this Search.
  // The intent is a latch, not a one-shot attempt: when that durable owner
  // clears, retry against the then-live generation and platform selection.
  useEffect(() => {
    if (!pendingUSAJobsRefreshRef.current) return;
    if (isJobWorkflowDeletionPending(id)) return;
    if (processingRunsRef.current.active || localQueueAdmissionRef.current) return;
    const liveData = getNode(id)?.data;
    if (!liveData || liveData.terminalFinalizationRecovery || liveData.manualAiResume?.runId) return;
    if (findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())) return;
    void triggerUSAJobsBackgroundSearch();
  }, [activeBoardRecoveryOwnerKey, data.manualAiResume, data.queuedModuleRun?.label, data.queuedModuleRun?.position, data.terminalFinalizationRecovery, deletionLifecycleRevision, getEdges, getNode, getNodes, hubState, id, triggerUSAJobsBackgroundSearch]);

  // (Results-cascade filters — score slider + per-source — moved to the Job Board
  // Module, which now owns the displayed cards. The Job Search Module has no cards
  // to filter.)

  // How far back to look for postings on each search. Persisted on node data
  // so it survives saves and applies to re-runs. 21 days = three weeks; sits
  // between the "freshest" applicant pool and the ~30-day mark where ~43% of
  // postings have been filled (see job-listing-age research notes).
  const maxAgeDays = data.maxAgeDays || 21;
  const setMaxAgeDays = useCallback((val) => {
    const n = Math.max(1, Math.min(JOB_MAX_AGE_DAYS_LIMIT, Math.floor(Number(val) || JOB_DEFAULT_AGE_DAYS)));
    updateGlobal(id, { maxAgeDays: n });
  }, [id, updateGlobal]);

  // Phase B merged the old standalone Target role box into this one Search
  // Brief field — the AI now determines the roles to search from whatever is
  // written here (explicit titles, a general direction, or nothing about
  // roles at all). The data/IPC field name stays `jobPreferences`; only the
  // user-facing label changed, so nothing downstream that keys off this field
  // name needed to change.
  // Location is edited through LOCAL draft state, not bound straight to
  // data.* . React Flow feeds node data via an external store (useSyncExternalStore);
  // re-renders from an external store bypass React's controlled-input caret
  // restoration, so a value={data.jobPreferences} textarea jumps the caret to the
  // end on every mid-text edit (backspace/insert). Mirroring locally keeps the value
  // update inside React's own event flow (caret preserved); onChange writes through
  // to the store, and the render-time reconcile picks up EXTERNAL store changes
  // (canvas load / reset) — React's "adjust state when a prop changes" pattern (no
  // effect, so it doesn't trip react-hooks/set-state-in-effect).
  const storeJobPreferences = data.jobPreferences || '';
  const storeSearchLocation = getSearchLocation(data);
  const storeSearchLocationKey = JSON.stringify(storeSearchLocation);
  const storeRemoteResidences = normalizeRemoteResidences(data.remoteResidences);
  const storeRemoteResidencesKey = JSON.stringify(storeRemoteResidences);
  const [jobPreferences, setJobPreferencesDraft] = useState(storeJobPreferences);
  const [lastStoreJobPreferences, setLastStoreJobPreferences] = useState(storeJobPreferences);
  if (storeJobPreferences !== lastStoreJobPreferences) {
    setLastStoreJobPreferences(storeJobPreferences);
    setJobPreferencesDraft(storeJobPreferences);
  }
  const [searchLocation, setSearchLocationDraft] = useState(storeSearchLocation);
  const [lastStoreSearchLocation, setLastStoreSearchLocation] = useState(storeSearchLocationKey);
  if (storeSearchLocationKey !== lastStoreSearchLocation) {
    setLastStoreSearchLocation(storeSearchLocationKey);
    setSearchLocationDraft(storeSearchLocation);
  }
  const [remoteResidences, setRemoteResidencesDraft] = useState(storeRemoteResidences);
  const [lastStoreRemoteResidences, setLastStoreRemoteResidences] = useState(storeRemoteResidencesKey);
  if (storeRemoteResidencesKey !== lastStoreRemoteResidences) {
    setLastStoreRemoteResidences(storeRemoteResidencesKey);
    setRemoteResidencesDraft(storeRemoteResidences);
  }
  const setJobPreferences = useCallback((val) => {
    const v = typeof val === 'string' ? val.slice(0, 4000) : '';
    setJobPreferencesDraft(v);
    updateGlobal(id, { jobPreferences: v });
  }, [id, updateGlobal]);
  const setSearchLocation = useCallback((next) => {
    const normalized = normalizeStructuredLocation(next);
    setSearchLocationDraft(normalized);
    // `preferredLocation` remains as a compatibility projection for saved
    // canvases and existing board adapters. It is never parsed from a new UI
    // value to decide country/subdivision semantics.
    updateGlobal(id, {
      searchLocation: normalized,
      preferredLocation: locationToLegacyText(normalized),
      canonicalLocation: null,
    });
  }, [id, updateGlobal]);
  const setRemoteResidence = useCallback((key, next) => {
    if (!['usa', 'canada', 'other'].includes(key)) return;
    const normalized = normalizeRemoteResidences({ ...remoteResidences, [key]: next });
    setRemoteResidencesDraft(normalized);
    writeLastRemoteResidences(normalized);
    updateGlobal(id, { remoteResidences: normalized });
  }, [id, remoteResidences, updateGlobal]);
  // Cascade-delete every spawned child on hub unmount. Only source cards: the
  // results cascade (jobcard/jobgroup) is spawned and owned by the Job Board
  // Module — no card ever carries this hub's id as hubId (the legacy pre-split
  // cascades are healed away by the v2 load migration).
  const cleanupAllJobChildren = useCallback(() => {
    EventLogger.log(`[JobSearch][${id}] Cleaning up source cards`);
    deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id,
      childTypes: ['jobsourcecard'],
    });
  }, [id, getNodes, getEdges, deleteElements]);

  const restoreBoardSourceGraph = useCallback((snapshot, retiredJobRunId = null) => {
    // Cancellation can race navigation/unmount. Never resurrect the old hub's
    // source graph into whatever canvas now occupies the shared ReactFlow store.
    if (!isMountedRef.current || getNode(id)?.type !== 'jobhub') return false;
    const restoreNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const restoredNodes = safeClone(Array.isArray(snapshot?.nodes) ? snapshot.nodes : []).map((node) => ({
      ...node,
      data: {
        ...(node.data || {}),
        // A same-id component receives this through props; a card that had
        // already unmounted initializes from it when React recreates the node.
        // Serialization strips the receipt because its only purpose is fencing
        // late progress from this in-memory abandoned generation.
        _boardRollbackProgressRestore: {
          nonce: restoreNonce,
          retiredJobRunId: retiredJobRunId || null,
        },
      },
    }));
    const requestedEdges = safeClone(Array.isArray(snapshot?.edges) ? snapshot.edges : []);
    const requestedNodeOrder = safeClone(Array.isArray(snapshot?.nodeOrder) ? snapshot.nodeOrder : []);
    const requestedEdgeOrder = safeClone(Array.isArray(snapshot?.edgeOrder) ? snapshot.edgeOrder : []);
    const currentOwnedIds = new Set(
      getNodes()
        .filter(node => node?.type === 'jobsourcecard' && node.data?.hubId === id)
        .map(node => node.id),
    );
    const affectedIds = new Set([...currentOwnedIds, ...restoredNodes.map(node => node.id)]);

    // Reconcile the two arrays from one immutable pre-run receipt. This removes
    // cards spawned by the abandoned run, resurrects cards its clean-dismiss
    // timer removed, and drops every incident warning edge before restoring the
    // prior edge payload. Unrelated hubs and user graph edits remain untouched.
    const reconcileNodes = (current) => {
      if (!isMountedRef.current || !current.some(node => node?.id === id && node.type === 'jobhub')) {
        return current;
      }
      return insertRestoredItemsAtCapturedAnchors(
        current,
        restoredNodes,
        requestedNodeOrder,
        node => node?.type === 'jobsourcecard' && node.data?.hubId === id,
      );
    };
    // ReactFlow batches setNodes, so derive the intended post-reconcile ids
    // synchronously. Relying on mutation inside the queued updater drops the
    // edge of any source card that needs to be resurrected.
    const requestedNodes = getNodes();
    const intendedNodes = reconcileNodes(requestedNodes);
    const reconciledNodeIds = new Set(intendedNodes.map(node => node.id));
    setNodes(reconcileNodes);
    const restoredEdges = requestedEdges.filter(edge => (
      reconciledNodeIds.has(edge?.source) && reconciledNodeIds.has(edge?.target)
    ));
    setEdges(current => {
      if (!isMountedRef.current || getNode(id)?.type !== 'jobhub') return current;
      return insertRestoredItemsAtCapturedAnchors(
        current,
        restoredEdges,
        requestedEdgeOrder,
        (edge) => {
        const incident = affectedIds.has(edge?.source)
          || affectedIds.has(edge?.target)
          || String(edge?.source || '').startsWith(`js-${id}-`)
          || String(edge?.target || '').startsWith(`js-${id}-`);
          return incident;
        },
      );
    });

    // Existing card components retain local progress and their retired-run
    // guard across a same-id graph replacement. Restore the full pre-run value
    // through a dedicated event; cards that had been removed simply seed from
    // this same node data when React mounts them again.
    if (!isMountedRef.current || getNode(id)?.type !== 'jobhub') return false;
    restoredNodes.forEach((node) => {
      if (!node.data?.sourceId) return;
      document.dispatchEvent(new CustomEvent('job-source-progress-restore', {
        detail: {
          hubId: id,
          sourceId: node.data.sourceId,
          persistedProgress: safeClone(node.data.persistedProgress || null),
          retiredJobRunId,
        },
      }));
    });
    return {
      nodes: restoredNodes,
      edges: restoredEdges,
    };
  }, [getNode, getNodes, id, isMountedRef, setEdges, setNodes]);

  useUnmountEffect(() => {
    if (isJobWorkflowDeletionPending(id)) {
      EventLogger.log(`[JobSearch][${id}] Unmount child cleanup deferred to pending deletion transaction`);
      return;
    }
    if (isJobWorkflowRelocationPending(id)) {
      EventLogger.log(`[JobSearch][${id}] Unmount child cleanup deferred to pending relocation transaction`);
      return;
    }
    cleanupAllJobChildren();
  });
  useUnmountEffect(() => {
    if (isJobWorkflowDeletionPending(id)) return;
    if (isJobWorkflowRelocationPending(id)) return;
    moduleRunQueue.cancelQueuedRunsForNode(id);
  });

  // ── Job-source platform cards (persistent, one per ACTIVE_JOB_SOURCE) ─────
  // Replaces the orbital ring with real canvas nodes connected by edges. Cards
  // are laid out in a circle around the hub — matches the SellHub →
  // CompSourceCard pattern so edges fan to each card's nearest hub side
  // instead of all bunching on one side. The user can drag any card anywhere
  // afterward. Each card subscribes to its own progress events and falls back
  // to the hub's `finalSourceCounts` between runs so the last-known count is
  // shown. Shared by `ensureSourceCards` (idle spawn) and
  // `ensureBlockedSourceCards` (post-run re-spawn for sources missing a card).
  const spawnSourceCardsAround = useCallback((items, edgeColor) => {
    if (items.length === 0) return 0;
    const existing = getNodes().filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id);
    const hubPos = getNode(id)?.position || { x: 0, y: 0 };
    const HUB_W = 260, HUB_H = 140, CARD_W = 140, CARD_H = 50;
    const cx = hubPos.x + HUB_W / 2;
    const cy = hubPos.y + HUB_H / 2;
    const total = existing.length + items.length;
    const stamp = Date.now();
    // Radius scales with card count so cards never overlap as the source list
    // grows (replaces a fixed 320 that only worked for ~12 sources).
    const RADIUS = radialRadius({ count: total, cardW: CARD_W, cardH: CARD_H, hubW: HUB_W, hubH: HUB_H });

    const newNodes = items.map(({ source, persistedProgress }, i) => {
      // Angle the card across the full circle; first card at top (-π/2).
      const angle = ((existing.length + i) / total) * 2 * Math.PI - Math.PI / 2;
      return {
        id: `js-${id}-${source.id}-${stamp}`,
        type: 'jobsourcecard',
        position: {
          x: cx + Math.cos(angle) * RADIUS - CARD_W / 2,
          y: cy + Math.sin(angle) * RADIUS - CARD_H / 2,
        },
        data: {
          sourceId: source.id,
          name:     source.name,
          letter:   source.letter,
          color:    source.color,
          domain:   source.domain,
          hubId:    id,
          ...(persistedProgress ? { persistedProgress } : {}),
        },
      };
    });

    // pickEdgeHandles routes each hub→card edge to the hub's nearest side so
    // edges don't all bunch on one side. Both ends render NodeHandles slots.
    const newEdges = newNodes.map(n => ({
      id: `edge-${id}-${n.id}`,
      source: id,
      target: n.id,
      ...pickEdgeHandles(
        { x: n.position.x + CARD_W / 2, y: n.position.y + CARD_H / 2 },
        { x: cx,                        y: cy                       },
      ),
      ...structuralEdge(edgeColor),
    }));

    if (addElementsGlobally) {
      addElementsGlobally(id, newNodes, newEdges, 'sibling');
    } else {
      addNodes(newNodes);
      addEdges(newEdges);
    }
    return total;
  }, [id, getNode, getNodes, addElementsGlobally, addNodes, addEdges]);

  const pruneDisabledSourceCards = useCallback(() => {
    const allowedSourceIds = new Set(activeEnabledSourceIds);
    const staleCards = getNodes().filter(
      n => n.type === 'jobsourcecard' && n.data?.hubId === id && !allowedSourceIds.has(n.data?.sourceId),
    );
    if (staleCards.length === 0) return;
    deleteElements({ nodes: staleCards.map(n => ({ id: n.id })) });
  }, [id, getNodes, deleteElements, activeEnabledSourceIds]);

  useEffect(() => {
    pruneDisabledSourceCards();
  }, [pruneDisabledSourceCards]);

  const ensureSourceCards = useCallback(({
    frameSourceCards = true,
    sourceIds = activeEnabledSourceIds,
  } = {}) => {
    const existingCards = getNodes().filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id);
    const effectiveSourceIds = Array.isArray(sourceIds) ? sourceIds : activeEnabledSourceIds;
    const allowedSourceIds = new Set(effectiveSourceIds);
    const staleCards = existingCards.filter(n => !allowedSourceIds.has(n.data?.sourceId));
    if (staleCards.length > 0) {
      deleteElements({ nodes: staleCards.map(n => ({ id: n.id })) });
    }
    const existingSourceIds = new Set(
      existingCards
        .filter(n => allowedSourceIds.has(n.data?.sourceId))
        .map(n => n.data?.sourceId),
    );
    const missing = effectiveSourceIds
      .map(sid => JOB_SOURCE_BY_ID[sid])
      .filter(s => s && !existingSourceIds.has(s.id));
    if (missing.length === 0) return;

    const total = spawnSourceCardsAround(
      missing.map(source => ({ source })),
      'rgba(96,165,250,0.5)',
    );

    // requestAnimationFrame gives ReactFlow one tick to register the new nodes;
    // a synchronous fitView would frame only the hub.
    if (frameSourceCards) {
      requestAnimationFrame(() => {
        fitView({ duration: fitViewDuration(total), padding: 0.2 });
      });
    }
  }, [id, getNodes, deleteElements, spawnSourceCardsAround, fitView, activeEnabledSourceIds]);

  // Guarantee every blocked source has a visible, actionable card when we pause
  // in 'sources-ready'. The block decision is finalized only at search END, but
  // source cards come and go DURING the (now long, deep-paginating) run — a card
  // can be gone by the time we pause, leaving "1 source blocked but nothing to
  // Solve." For any blocked source missing a card, spawn one SEEDED with the
  // failure (the live progress event already fired before this card existed, so
  // the reason + Solve target must come from persisted state). Existing cards
  // are synchronously promoted to the final derived warning; this matters when
  // their last source-progress event was a clean `done` before final QA ran.
  const ensureBlockedSourceCards = useCallback((blockingWarnings, sourceIds = activeEnabledSourceIds) => {
    const blocks = (blockingWarnings || []).filter(w => isJobSourceWarningGating(w) && w.sourceId);
    if (blocks.length === 0) return;
    const allowedSourceIds = new Set(Array.isArray(sourceIds) ? sourceIds : activeEnabledSourceIds);
    const existingSourceIds = new Set(
      getNodes()
        .filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id)
        .map(n => n.data?.sourceId),
    );
    blocks
      .filter(w => existingSourceIds.has(w.sourceId))
      .forEach(w => document.dispatchEvent(new CustomEvent('job-source-warning-sync', {
        detail: { hubId: id, sourceId: w.sourceId, warning: w, jobRunId: jobRunIdRef.current || null },
      })));
    const missing = blocks.filter(w => allowedSourceIds.has(w.sourceId) && !existingSourceIds.has(w.sourceId));
    if (missing.length === 0) return;

    const items = missing.map(w => ({
      source: JOB_SOURCE_BY_ID[w.sourceId] ||
        { id: w.sourceId, name: w.sourceId, letter: (w.sourceId[0] || '?').toUpperCase(), color: '#ef4444', domain: '' },
      persistedProgress: {
        status:  'done',
        // Spread the FULL warning so the re-spawned card keeps resumeState (Indeed
        // 'Continue' resumes instead of full re-scrape), openSecondTab (Glassdoor
        // 2-tab solve), and shortLabel (friendly chip) — not just the 4 base fields.
        warning: { ...w },
        url:     w.url || null,
        count:   w.sourceJobCount || 0,
        jobRunId: jobRunIdRef.current || null,
      },
    }));
    spawnSourceCardsAround(items, 'rgba(239,68,68,0.6)');
    EventLogger.log(`[JobSearch][${id}] Re-spawned ${missing.length} blocked source card(s) to resolve: ${missing.map(w => w.sourceId).join(', ')}`);
  }, [id, getNodes, spawnSourceCardsAround, activeEnabledSourceIds]);

  // (Result-card filter re-apply + height-driven re-flow moved to the Job Board
  // Module along with the displayed cascade.)

  /**
   * Steps 4-5 of the pipeline: scoring → bucketing → spawn → set 'done'.
   * Extracted so the resume-after-pause path (user cleared their last block
   * warning) can re-enter scoring without re-fetching the resume + search.
   *
   * The caller is responsible for: owning the processing guard, capturing the
   * cancellation epoch, and releasing only its own guard token. Mirrors the marketplace
   * synthesizeAndPrice pattern.
   */
  // Post-scoring: STORE the scored jobs + summary counts → mark done. The Job
  // Search Module no longer buckets or spawns the results cascade — that moved to
  // the Job Board Module, which reads data.scoredJobs from each connected search
  // module, re-buckets the union, and displays the merged tree. Shared by the
  // real-time path (runScoringAndSpawn) and the async batch path (the poll
  // effect) so both leave the hub in the same done summary state. (`profile`,
  // `originalPos`, `activeTargetRole` are still passed by callers but no longer
  // needed here.)
  const finishScoringAndSpawn = useCallback(async ({
    scoredJobs, gatheredCount, scrapedCount, scrapeWarnings = [], collectionScopeCaveats = [],
    aiSkipped = false, collectionOnly = false, testMode = false,
    jobRunId = null, cancelled = () => false, completeRun = true,
    preferenceMatchedCount = null, preferenceFilteredCount = null,
    preferenceEvaluation = null, preferenceCandidatePool = null,
    resultDisposition = 'scored',
  }) => {
    if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunId });
    const displayed = Array.isArray(scoredJobs) ? scoredJobs : [];

    const finalSourceCounts = {};
    displayed.forEach(job => { finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1; });

    const scores = displayed.map(j => j.matchScore || 0);
    const scoreRangeMin = scores.length ? Math.min(...scores) : 0;
    const scoreRangeMax = scores.length ? Math.max(...scores) : 100;

    // Scoring alone does not expose results. The connected Job Board performs
    // the authoritative seen-history write only after it has added cards for
    // this result set to the canvas.
    // A batch poll can cross the user pressing Cancel while finishing. Do not
    // let that stale continuation restore a done state after the hub has
    // already been reset/re-run.
    if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunId });

    // Re-analysis deliberately has no search-run lifecycle or history sidecar
    // to complete. For a real search, finish the receipt/cleanup transaction
    // before publishing `done`: a renderer teardown in the old fire-and-forget
    // gap could leave a visible completion with a resumable manifest.
    const completion = completeRun && jobRunId
      ? await completeJobRun(
        jobRunId,
        displayed.length > 0 ? 'completed' : 'failed',
        displayed.length > 0 ? 'populated' : 'incomplete',
        canvasFilePath,
        displayed.length,
        moduleFingerprint(displayed),
        cancelled,
      )
      : null;
    if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunId });
    const finalizationError = terminalFinalizationError(
      completeRun ? jobRunId : null,
      canvasFilePath,
      completion,
    );

    updateGlobal(id, {
      hubState: 'done',
      // The hub is the only in-canvas record of WHICH run produced these
      // results. Every other completing branch already stamps it; this one did
      // not, so after a scored run `data.jobRunId` was null and both consumers
      // that key off it silently degraded: the saved-snapshot correlation at
      // `savedAnalysisMatchesCurrentRun` could never be true, and the main
      // process's `snapshotIsThisRun` recovery guard (jobs.js) fell through its
      // `!jobRunId` escape on every call. A re-analysis of saved results passes
      // a possibly-null token with completeRun:false; keep the live one rather
      // than erasing it.
      ...(jobRunId ? { jobRunId } : {}),
      scoredJobs: displayed, // read by a connected Job Board Module on Combine
      resultCount: displayed.length,
      totalScoredCount: displayed.length,
      scrapedCount: scrapedCount ?? displayed.length,
      gatheredCount: gatheredCount ?? scrapedCount ?? displayed.length,
      preferenceMatchedCount,
      preferenceFilteredCount,
      preferenceEvaluation,
      // The pool exists so a later Job Preferences edit can re-judge listings
      // this run FILTERED OUT. When no preferences ran, both counts come back
      // null and the pool is the untouched job list — a byte-for-byte second
      // copy of the same listings already in `scoredJobs`, saved into
      // canvas.json on every autosave for a feature the run never used.
      // `handleReanalyze` already falls back to `scoredJobs` when the pool is
      // empty, so dropping it here costs nothing and halves the persisted
      // job payload for anyone not using preferences.
      preferenceCandidatePool: (preferenceMatchedCount == null && preferenceFilteredCount == null)
        ? null
        : (Array.isArray(preferenceCandidatePool) ? preferenceCandidatePool : null),
      // Keep testMode as a legacy alias for old saved canvases only.
      aiSkipped: !!aiSkipped,
      collectionOnly: !!collectionOnly,
      testMode: !!testMode,
      // A successful scorer settlement is authoritative only for its positive
      // rows. A zero-result search is stamped separately as `empty-complete`
      // before it reaches this scorer path.
      resultDisposition,
      finalSourceCounts,
      scoreRangeMin,
      scoreRangeMax,
      pendingJobs: null,
      pendingCareerData: null,
      pendingTargetRole: null,
      pendingJobPreferences: null,
      pendingJobPreferencePlan: null,
      pendingJobPreferencesInterpretation: null,
      scrapeWarnings: Array.isArray(scrapeWarnings) ? scrapeWarnings : [],
      collectionScopeCaveats: normalizeCollectionScopeCaveats(collectionScopeCaveats),
      rerunOutcome: null,
      rerunNotice: null,
      errorMessage: finalizationError,
    });
    return finalizationError
      ? searchRunOutcome('recovery-finalization-failed', { runId: jobRunId, resultDisposition, error: finalizationError })
      : searchRunOutcome('completed', { runId: jobRunId, resultDisposition });
  }, [id, updateGlobal, completeJobRun, canvasFilePath]);

  const runScoringAndSpawn = useCallback(async ({
    profile, careerData = data.careerData, jobs, gatheredCount,
    scrapedCount = Array.isArray(jobs) ? jobs.length : 0,
    scrapeWarnings, collectionScopeCaveats = data.collectionScopeCaveats, activeTargetRole, originalPos,
    jobRunId = null, cancelled, locationSnapshot = null, completeRun = true,
    manualAiRunId = null, resultMode = 'replace',
    appendBaseData = null, appendCanCommit = () => true,
    // An append recovery may retain the original run's aggregate gathered
    // count in its snapshot. Never add that aggregate to an already-done hub;
    // callers pass only the genuinely new source volume here.
    gatheredDelta = null,
    activeJobPreferences = '', jobPreferencesInterpretation = null,
    preferenceMatchedCount = null, preferenceFilteredCount = null,
    preferenceEvaluation = null, preferenceCandidatePool = null,
  }) => {
    const currentId = id;
    const effectiveManualAiRunId = manualAiRunId || createManualAiRunId(currentId);

    // Step 4: Scoring
    setScoringProgress(null); // clear any prior run's counter; backend re-paints "0 / M"
    // Preserve non-gating collection facts across the scoring transition —
    // without retaining the normalized value here, a completed Glassdoor
    // nation-scope disclosure could be silently dropped before it reaches
    // finishScoringAndSpawn below.
    updateGlobal(currentId, {
      hubState: 'scoring',
      jobCount: jobs.length,
      collectionScopeCaveats: normalizeCollectionScopeCaveats(collectionScopeCaveats),
    });
    const effectiveLocationSnapshot = locationSnapshot || data.locationSnapshot || {
      searchLocation: getSearchLocation({
        searchLocation: data.searchLocation,
        preferredLocation: data.preferredLocation,
        canonicalLocation: data.canonicalLocation,
      }),
      remoteResidences: normalizeRemoteResidences(data.remoteResidences),
    };
    const scoreResult = await window.electronAPI.scoreJobs({
      jobs,
      profile,
      careerData,
      nodeId: currentId,
      manualAiRunId: effectiveManualAiRunId,
      manualAiRecoveryMode: resultMode === 'append' ? 'append-scored-jobs' : null,
      targetRole: activeTargetRole,
      jobPreferences: activeJobPreferences,
      jobPreferencePlan: jobPreferencesInterpretation,
      preferencePlan: jobPreferencesInterpretation,
      jobPreferencesInterpretation,
      preferenceEvaluation,
      preferenceCandidatePool,
      searchLocation: effectiveLocationSnapshot.searchLocation,
      remoteResidences: effectiveLocationSnapshot.remoteResidences,
      snapshotContext: {
        sourceHubId: currentId,
        runId: jobRunId,
        canvasFilePath,
        resumeSummary: buildResumeSummary(profile),
        sourceGatheredCount: gatheredCount,
        searchLocation: effectiveLocationSnapshot.searchLocation,
        remoteResidences: effectiveLocationSnapshot.remoteResidences,
        jobPreferences: activeJobPreferences,
        jobPreferencePlan: jobPreferencesInterpretation,
        preferencePlan: jobPreferencesInterpretation,
        jobPreferencesInterpretation,
        preferenceEvaluation,
        preferenceCandidatePool,
      },
    });
    if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunId });
    if (!scoreResult.success) {
      throw new Error(scoreResult.error || 'Failed to score jobs');
    }

    if (resultMode === 'append') {
      const appendCommitted = await appendJobsToDoneCanvas({
        scoredJobs: scoreResult.scoredJobs,
        filteredWarnings: scrapeWarnings,
        gatheredDelta: gatheredDelta ?? jobs.length,
        preferenceMatchedDelta: scoreResult.preferenceMatchedCount ?? preferenceMatchedCount,
        preferenceFilteredDelta: scoreResult.preferenceFilteredCount ?? preferenceFilteredCount,
        preferenceEvaluation: scoreResult.preferenceEvaluation ?? preferenceEvaluation,
        preferenceCandidatePool: scoreResult.preferenceCandidatePool ?? preferenceCandidatePool,
        baseData: appendBaseData,
        canCommit: appendCanCommit,
      });
      if (!appendCommitted) {
        return searchRunOutcome(cancelled() ? 'cancelled' : 'superseded', {
          runId: jobRunId,
          error: 'The saved append target changed before scoring completed.',
        });
      }
      await completeManualAiRun(effectiveManualAiRunId);
      if (cancelled()) {
        return searchRunOutcome('cancelled', { runId: jobRunId });
      }
      return searchRunOutcome('completed', {
        runId: jobRunId,
        resultDisposition: (
          (Array.isArray(appendBaseData?.scoredJobs) && appendBaseData.scoredJobs.length > 0)
          || (Array.isArray(scoreResult.scoredJobs) && scoreResult.scoredJobs.length > 0)
        ) ? 'scored' : 'incomplete',
      });
    }

    const outcome = await finishScoringAndSpawn({
      scoredJobs: scoreResult.scoredJobs,
      profile,
      gatheredCount,
      scrapedCount,
      scrapeWarnings,
      collectionScopeCaveats,
      activeTargetRole,
      originalPos,
      aiSkipped: !!scoreResult.aiSkipped,
      collectionOnly: !!scoreResult.collectionOnly,
      testMode: !!scoreResult.testMode,
      preferenceMatchedCount: scoreResult.preferenceMatchedCount ?? preferenceMatchedCount,
      preferenceFilteredCount: scoreResult.preferenceFilteredCount ?? preferenceFilteredCount,
      preferenceEvaluation: scoreResult.preferenceEvaluation ?? preferenceEvaluation,
      preferenceCandidatePool: scoreResult.preferenceCandidatePool ?? preferenceCandidatePool,
      jobRunId,
      cancelled,
      completeRun,
    });
    if (outcome?.status !== 'cancelled') {
      await completeManualAiRun(effectiveManualAiRunId);
    }
    return outcome || searchRunOutcome('failed', {
      runId: jobRunId,
      error: 'The scoring pipeline ended without a terminal result.',
    });
  }, [id, updateGlobal, canvasFilePath, finishScoringAndSpawn, appendJobsToDoneCanvas, completeManualAiRun, data.locationSnapshot, data.searchLocation, data.preferredLocation, data.canonicalLocation, data.remoteResidences, data.careerData, data.collectionScopeCaveats]);

  /**
   * Shared post-search disposition for the search + resume paths: pause in
   * 'sources-ready' when a gating warning blocks (so the user Solves/Skips before
   * we spend AI tokens), OR terminate 'done' when nothing was found. Returns
   * `{ shouldScore, warnings }`, where `warnings` is the final reconciled list
   * the caller must pass into every downstream terminal/scoring state. The
   * block-gate MUST precede the empty terminal: a run can
   * return 0 jobs *because* the only productive source was blocked, and those
   * jobs only get scored via the 'sources-ready' auto-resume after Solve.
   *
   * Each caller passes its OWN inputs so the deliberate per-path differences are
   * preserved: `warnings` (runPipeline passes already-resolved-filtered
   * effectiveWarnings; resume passes raw), and `canvasFilePath` (runPipeline's
   * live closure vs. resume's await-stable snapshot). The test-mode collect and
   * the score handoff (with each path's own gatheredCount) stay with the caller.
   */
  const handlePostSearchResult = useCallback(async ({
    currentId, foundJobs, warnings, blockingWarnings, profile, activeTargetRole,
    activeJobPreferences = '', jobPreferencesInterpretation = null,
    careerData = data.careerData, canvasFilePath: cfp,
    jobRunId = null, locationSnapshot = null, descriptionRecoveryJobs = null, descriptionRecoveryState = null,
    collectionScopeCaveats = [],
    gatheredCount = null, cancelled = () => false, sourceIds = activeEnabledSourceIds,
  }) => {
    jobRunIdRef.current = jobRunId;
    if (blockingWarnings.length > 0 && !SKIP_AI_FOR_TESTING) {
      // Publish the backend token before the first checkpoint await. React
      // Flow's deletion callback receives node data, not this component ref; if
      // the user deletes the hub during that write it needs the exact token to
      // retire the manifest/checkpoint rather than stranding the canvas.
      if (jobRunId) updateGlobal(currentId, { jobRunId });
      cancelCleanSourceCardDismiss();
      // These refs are the synchronous source of truth for an immediate
      // Resolve/Skip click before React commits the update below.
      pendingJobsRef.current = foundJobs;
      scrapeWarningsRef.current = warnings;
      gatheredCountRef.current = gatheredCount ?? foundJobs.length;
      // Description-recovery Solve actions run before score-jobs writes its usual
      // snapshot. Persist the current run's full recovery universe now; otherwise
      // a Solve can load a prior same-hub snapshot or mistake the score-safe
      // subset for a completed source.
      //
      // Must list every source whose Solve targets stranded description rows —
      // i.e. JOB_SOURCE_RESOLVE_CONFIG's requiresDescriptionEnrichment set
      // (google, ziprecruiter, glassdoor) plus LinkedIn's guest-wall recovery.
      // Glassdoor earns its place now that a panel-429 blocks BEFORE scoring:
      // without it that run would pause with no snapshot on disk at all, and
      // its Solve would have nothing to target.
      const descriptionRecoverySourceIds = new Set(
        blockingWarnings.filter(isDescriptionRecoverySourceWarning).map(warning => warning.sourceId),
      );
      // Only Google and LinkedIn require the strict saved recovery universe.
      // Glassdoor/ZipRecruiter can still use their ordinary visible-window
      // resolver if that snapshot write fails.
      const strictRecoverySourceIds = new Set(
        [...descriptionRecoverySourceIds].filter(sourceId => sourceId === 'google' || sourceId === 'linkedin'),
      );
      const needsDescriptionRecoverySnapshot = descriptionRecoverySourceIds.size > 0;
      let recoverySnapshotReady = true;
      if (needsDescriptionRecoverySnapshot) {
        try {
          const saved = await window.electronAPI?.saveJobAnalysisSnapshot?.({
            jobs: foundJobs,
            descriptionRecoveryJobs,
            descriptionRecoveryState,
            profile,
            careerData,
            nodeId: currentId,
            targetRole: activeTargetRole,
            jobPreferences: activeJobPreferences,
            jobPreferencePlan: jobPreferencesInterpretation,
            jobPreferencesInterpretation,
            preferenceCandidatePool: foundJobs,
            // This is the sole pre-score write that must be recoverable by an
            // exact hub/run Source Solve. Ordinary analysis snapshots are not
            // promoted to the run-keyed recovery sidecar.
            saveDescriptionRecoveryCheckpoint: true,
            snapshotContext: {
              sourceHubId: currentId,
              runId: jobRunId,
              canvasFilePath: cfp,
              resumeSummary: buildResumeSummary(profile),
              sourceGatheredCount: gatheredCount,
              locationSnapshot,
              searchLocation: locationSnapshot?.searchLocation || null,
              remoteResidences: locationSnapshot?.remoteResidences || null,
            },
          });
          // The handler is handleSafe: an I/O failure resolves to an error
          // shape instead of throwing. A saved snapshot with no/mismatched run
          // token is equally unsafe for a strict current-run description Solve.
          recoverySnapshotReady = saved?.success === true
            && saved?.saved === true
            && saved?.recoveryCheckpointSaved === true
            && !!jobRunId
            && saved?.meta?.runId === jobRunId;
          if (!recoverySnapshotReady) {
            EventLogger.error(
              `[JobSearch][${currentId}] Pre-score description recovery checkpoint was not saved for run ${jobRunId || 'missing'}: ${saved?.error || 'missing or mismatched snapshot receipt'}`,
            );
          }
        } catch (err) {
          recoverySnapshotReady = false;
          EventLogger.error(`[JobSearch][${currentId}] Failed to save pre-score description recovery snapshot:`, err);
        }
      }
      // A slow checkpoint write can settle after Reset/delete has cancelled its
      // owning run. Never resurrect that run by publishing sources-ready.
      if (cancelled()) {
        return {
          shouldScore: false,
          warnings,
          outcome: searchRunOutcome('cancelled', { runId: jobRunId }),
        };
      }
      let latestWarnings = reconcileJobSourceWarnings(
        warnings,
        sourceWarningOverridesDuringSearchRef.current,
      );
      if (!recoverySnapshotReady) {
        latestWarnings = latestWarnings.map(warning => (
          strictRecoverySourceIds.has(warning?.sourceId)
            ? descriptionRecoveryCheckpointWriteFailureWarning(warning)
            : warning
        ));
      }
      const latestBlockingWarnings = latestWarnings.filter(isJobSourceWarningGating);
      // A Skip during the awaited write is safe and intentional. The backend's
      // original block was reconciled above, so continue straight to scoring
      // rather than restoring the skipped source in sources-ready.
      scrapeWarningsRef.current = latestWarnings;
      if (latestBlockingWarnings.length === 0) {
        updateGlobal(currentId, {
          scrapeWarnings: latestWarnings,
          collectionScopeCaveats: normalizeCollectionScopeCaveats(collectionScopeCaveats),
        });
        return { shouldScore: true, warnings: latestWarnings };
      }
      // Do not publish the actionable sources-ready state until the current
      // run's recovery snapshot has settled. Otherwise a very fast Solve can
      // read an older run's sidecar before this async write reaches disk.
      hubStateRef.current = 'sources-ready';
      updateGlobal(currentId, {
        hubState: 'sources-ready',
        pendingJobs: foundJobs,
        pendingTargetRole: activeTargetRole,
        pendingJobPreferences: activeJobPreferences,
        pendingJobPreferencePlan: jobPreferencesInterpretation,
        pendingJobPreferencesInterpretation: jobPreferencesInterpretation,
        pendingCareerData: careerData,
        jobCount: foundJobs.length,
        // Resume scoring must retain the source-card-aligned total from this
        // search instead of deriving it later from the history-deduped pending
        // rows.
        gatheredCount: gatheredCount ?? foundJobs.length,
        scrapeWarnings: latestWarnings,
        collectionScopeCaveats: normalizeCollectionScopeCaveats(collectionScopeCaveats),
        jobRunId,
      });
      // Guarantee a Solve/Skip card for every blocked source — a card can be lost
      // during the long run, stranding the user with "blocked but nothing to resolve".
      ensureBlockedSourceCards(latestBlockingWarnings, sourceIds);
      return {
        shouldScore: false,
        warnings: latestWarnings,
        collectionScopeCaveats,
        outcome: searchRunOutcome('paused', {
          runId: jobRunId,
          error: 'Resolve or skip the blocked job sources before this search can finish.',
        }),
      };
    }

    if (foundJobs.length === 0) {
      // No blocked sources left to recover. This run owns the terminal result:
      // replace any prior results and show a simple "0 new jobs" summary.
      // Replace the prior analysis snapshot before exposing this terminal state:
      // otherwise the bug reporter's snapshot-only snippet/salary diagnostics
      // silently describe the PREVIOUS non-empty run. Await this small local
      // write so a report opened immediately after the empty result is coherent.
      try {
        const saved = await window.electronAPI?.saveJobAnalysisSnapshot?.({
          jobs: [],
          profile,
          careerData,
          nodeId: currentId,
          targetRole: activeTargetRole,
          snapshotContext: {
            sourceHubId: currentId,
            runId: jobRunId,
            canvasFilePath: cfp,
            resumeSummary: buildResumeSummary(profile),
            sourceGatheredCount: gatheredCount,
            locationSnapshot,
            searchLocation: locationSnapshot?.searchLocation || null,
            remoteResidences: locationSnapshot?.remoteResidences || null,
          },
        });
        if (saved && !saved.saved) {
          EventLogger.error(`[JobSearch][${currentId}] Failed to save empty-run analysis snapshot: ${saved.error || 'unknown error'}`);
        }
      } catch (err) {
        // Saving diagnostics must not prevent a real empty result from
        // completing. The report's run-ID guard will suppress any older file.
        EventLogger.error(`[JobSearch][${currentId}] Failed to save empty-run analysis snapshot:`, err);
      }
      // Finalize before publishing `done`, otherwise a quit/reset in the old
      // fire-and-forget window could leave this apparently-finished zero run
      // resumable on the next launch.
      const completion = jobRunId
        ? await completeJobRun(jobRunId, 'completed', 'zero', cfp, 0, moduleFingerprint([]), cancelled)
        : null;
      if (cancelled()) {
        return {
          shouldScore: false,
          warnings,
          outcome: searchRunOutcome('cancelled', { runId: jobRunId }),
        };
      }
      const finalizationError = terminalFinalizationError(jobRunId, cfp, completion);
      // Reset slider range + counts so the done-state UI doesn't show stale values.
      updateGlobal(currentId, {
        hubState: 'done',
        scoredJobs: [],
        finalSourceCounts: {},
        jobCount: 0,
        resultCount: 0,
        totalScoredCount: 0,
        scrapedCount: 0,
        // Preserve the backend funnel even when zero rows survive. Otherwise a
        // clean 88 fetched → 88 relevance-filtered run looks identical to a
        // source that returned no rows at all.
        gatheredCount: gatheredCount ?? 0,
        scoreRangeMin: 0,
        scoreRangeMax: 100,
        scoreThreshold: 0,
        scrapeWarnings: warnings,
        collectionScopeCaveats: normalizeCollectionScopeCaveats(collectionScopeCaveats),
        pendingJobs: null,
        jobRunId,
        rerunOutcome: 'no-new-results',
        rerunNotice: null,
        resultDisposition: 'empty-complete',
        errorMessage: finalizationError,
      });
      pendingJobsRef.current = null;
      scrapeWarningsRef.current = warnings;
      hubStateRef.current = 'done';
      return {
        shouldScore: false,
        warnings,
        collectionScopeCaveats,
        outcome: finalizationError
          ? searchRunOutcome('recovery-finalization-failed', {
            runId: jobRunId,
            resultDisposition: 'empty-complete',
            error: finalizationError,
          })
          : searchRunOutcome('completed', {
            runId: jobRunId,
            resultDisposition: 'empty-complete',
          }),
      };
    }

    return { shouldScore: true, warnings };
  }, [activeEnabledSourceIds, updateGlobal, ensureBlockedSourceCards, cancelCleanSourceCardDismiss, data.careerData, completeJobRun]);

  /**
   * Drives the full pipeline. Pass `filePath` for a fresh resume parse, or
   * `profile` to skip parsing and re-run from query construction onward.
   * `filePath` takes precedence when both are provided.
   */
  const runPipeline = useCallback(async ({
    filePath,
    filePaths,
    profile: providedProfile,
    frameSourceCards = true,
    runOrigin = 'initial',
    manualAiRunId = null,
    // A Job Board can own the queue entry for this work. The search module
    // still executes the source-scoped pipeline (all IPC/staging identifiers
    // must remain this hub's id), but it must not try to acquire the same lane
    // again or the parent/child workflow would deadlock.
    queueManagedByBoard = false,
    parentCancelled = null,
    orchestratorNodeId = null,
    boardRunId = null,
    freshImportCapability = null,
  } = {}) => {
    if (isJobWorkflowDeletionPending(id)) {
      return searchRunOutcome('cancelled', { error: 'This Job Search is pending deletion.' });
    }
    if (!queueManagedByBoard) {
      const durableBoardOwner = findJobSearchBoardActiveRecoveryOwner(
        id,
        getNodes(),
        getEdges(),
      );
      if (durableBoardOwner) {
        EventLogger.log(
          `[JobSearch][${id}] Direct search deferred to durable Job Board ${durableBoardOwner.orchestratorNodeId}`,
        );
        addToast({
          title: 'Run from Job Board',
          description: 'This Job Search is reserved by an interrupted Job Board run. Finish or cancel that Board first.',
          type: 'info',
        });
        return searchRunOutcome('paused', {
          error: 'This Job Search is reserved by an interrupted Job Board run.',
        });
      }
    }
    const liveData = getNode(id)?.data || data;
    if (hasPendingManualAiRetirement(liveData)) {
      return searchRunOutcome('not-ready', {
        error: 'Finish the older manual-AI cancellation cleanup before starting another search.',
      });
    }
    if (!window.electronAPI) {
      return searchRunOutcome('failed', { error: 'Job Search processing is unavailable.' });
    }
    if (processingRunsRef.current.active || (!queueManagedByBoard && localQueueAdmissionRef.current)) {
      return searchRunOutcome('busy', { error: 'This Job Search module is already running.' });
    }
    // Capture these once per run. A user may edit fields while a long scrape is
    // in progress; compensation research must use the locations that were
    // explicitly configured when this run began, not a later edit.
    let runLocationSnapshot = {
      searchLocation: getSearchLocation(liveData),
      remoteResidences: normalizeRemoteResidences(liveData.remoteResidences),
    };
    let runCollectionLimits = collectionLimits;
    let runEnabledSourceIds = enabledSourceIds;
    let runActiveEnabledSourceIds = activeEnabledSourceIds;
    const locationProblem = locationValidationMessage(runLocationSnapshot.searchLocation);
    if (!hasRequiredLocations(runLocationSnapshot.searchLocation)) {
      EventLogger.log(`[JobSearch][${id}] Run refused — error banner raised: ${locationProblem}`);
      updateGlobal(id, { errorMessage: locationProblem, rerunOutcome: null, rerunNotice: null });
      addToast({ title: 'Complete job locations', description: locationProblem, type: 'error' });
      return searchRunOutcome('not-ready', { error: locationProblem });
    }
    if (activeEnabledSourceIds.length === 0) {
      const message = 'Select at least one job platform before running the search.';
      EventLogger.log(`[JobSearch][${id}] Run refused — error banner raised: ${message}`);
      updateGlobal(id, { errorMessage: message, rerunOutcome: null, rerunNotice: null });
      addToast({ title: 'Choose a Job Platform', description: message, type: 'error' });
      return searchRunOutcome('not-ready', { error: message });
    }
    // Career data can come from one OR many dropped files; normalize to a list.
    // A single `filePath` (canvas-created hub) still works as a one-element list.
    const paths = (Array.isArray(filePaths) && filePaths.length)
      ? filePaths.filter(Boolean)
      : (filePath ? [filePath] : []);
    if (paths.length === 0 && !providedProfile) {
      return searchRunOutcome('not-ready', { error: 'This Job Search module has no career files or stored profile.' });
    }
    const admissionToken = Symbol(`job-search:${id}`);
    if (!queueManagedByBoard) localQueueAdmissionRef.current = admissionToken;
    let processingToken = null;
    const currentId = id;
    const effectiveManualAiRunId = manualAiRunId || createManualAiRunId(currentId);
    // Capture cancellation epoch at start; cancelled() returns true after
    // any reset/unmount so we can drop late settlements without mutating
    // freshly-reverted state.
    const locallyCancelled = epoch.start();
    const cancelled = () => locallyCancelled()
      || (typeof parentCancelled === 'function' && parentCancelled());
    let lease = null;
    let standaloneBecameBoardManaged = false;
    let deletionBlockedAtLaneStart = false;
    try {
      if (!queueManagedByBoard) {
        lease = await moduleRunQueue.acquireModuleRun({
          nodeId: currentId,
          kind: 'jobsearch',
          // Job-domain AI is a single copy/paste handoff surface. Keep whole
          // job-search workflows in one FIFO lane so prompts and results from
          // different hubs can never overlap or be mistaken for one another.
          lane: 'job-search',
          label: 'Job search',
          onQueued: ({ position }) => {
            updateGlobal(currentId, {
              queuedModuleRun: { label: 'Job search', position },
            });
          },
          onQueueUpdate: ({ position }) => {
            updateGlobal(currentId, { queuedModuleRun: { label: 'Job search', position } });
          },
          onStart: () => {
            if (isJobWorkflowDeletionPending(currentId)) deletionBlockedAtLaneStart = true;
            if (cancelled() || isJobWorkflowDeletionPending(currentId)) throw new Error('Node deleted');
            // Ownership is live graph state. A Search that was standalone when
            // queued may now belong to a Board; consume this lease only long
            // enough to restore its pre-queue snapshot, then let the Board's
            // already-queued transaction start with an untouched child.
            if (
              isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())
              || findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())
            ) {
              standaloneBecameBoardManaged = true;
              return;
            }
            updateGlobal(currentId, { queuedModuleRun: null });
          },
        });
      } else {
        if (!orchestratorNodeId) throw new Error('A board-managed search requires an orchestrator node id.');
        updateGlobal(currentId, { queuedModuleRun: null });
        EventLogger.log(`[JobSearch][${currentId}] Queue delegated to Job Board ${orchestratorNodeId}`);
      }

      if (standaloneBecameBoardManaged) {
        // Queue presentation changed only this transient receipt. Preserve
        // every live edit made while waiting instead of replacing the whole
        // node with a click-time snapshot.
        updateGlobal(currentId, { queuedModuleRun: null });
        EventLogger.log(
          `[JobSearch][${currentId}] Queued direct run declined — a connected Job Board now owns search admission`,
        );
        addToast({
          title: 'Run from Job Board',
          description: 'This queued search was kept unchanged. Use Search selected & combine on its connected Job Board.',
          type: 'info',
        });
        return searchRunOutcome('not-ready', { error: 'Run this connected search from its Job Board.' });
      }

      if (
        !queueManagedByBoard
        && (
          isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())
          || findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())
        )
      ) {
        updateGlobal(currentId, { queuedModuleRun: null });
        EventLogger.log(
          `[JobSearch][${currentId}] Direct run declined after queue admission — a Job Board now owns this Search`,
        );
        addToast({
          title: 'Run from Job Board',
          description: 'This queued search was reserved by an interrupted Job Board run and was kept unchanged.',
          type: 'info',
        });
        return searchRunOutcome('paused', {
          error: 'This queued search was reserved by an interrupted Job Board run.',
        });
      }

      const laneTurnData = getNode(currentId)?.data || null;
      if (
        !laneTurnData
        || laneTurnData.locked
        || isJobWorkflowDeletionPending(currentId)
        // Verification can begin while a request is waiting in the shared
        // lane. Re-check at its actual turn before destructive setup;
        // otherwise the stale queued callback can start provider work while
        // the UI correctly says "Checking Connections".
        || hasPendingManualAiRetirement(laneTurnData)
      ) {
        return searchRunOutcome('not-ready', {
          error: 'This Job Search became unavailable while it was queued.',
        });
      }
      if (platformsVerifyingRef.current) {
        return searchRunOutcome('not-ready', {
          error: 'Its selected platform connections are still being checked.',
          ...(queueManagedByBoard ? { transientReason: 'platforms-verifying' } : {}),
        });
      }
      runLocationSnapshot = {
        searchLocation: getSearchLocation(laneTurnData),
        remoteResidences: normalizeRemoteResidences(laneTurnData.remoteResidences),
      };
      const liveLocationProblem = locationValidationMessage(runLocationSnapshot.searchLocation);
      if (!hasRequiredLocations(runLocationSnapshot.searchLocation)) {
        return searchRunOutcome('not-ready', { error: liveLocationProblem });
      }
      runCollectionLimits = normalizeJobCollectionLimits(laneTurnData.collectionLimits);
      runEnabledSourceIds = normalizeEnabledJobSourceIds(laneTurnData.enabledSourceIds);
      runActiveEnabledSourceIds = getRunnableJobSourceIds(
        runEnabledSourceIds,
        ACTIVE_JOB_SOURCES,
        runCollectionLimits,
      );
      if (runActiveEnabledSourceIds.length === 0) {
        return searchRunOutcome('not-ready', {
          error: 'Select at least one job platform before running the search.',
        });
      }

      // Authenticate before spending a fresh-import capability. A rejected
      // login preflight has not started a provider run or changed the career
      // input, so it must leave the import available for the user to retry
      // from its Job Board after signing in. Consuming below first would turn
      // this recoverable setup failure into a permanent "Clear + import"
      // state, leaving the Board action disabled even after login succeeds.
      // LinkedIn is intentionally excluded: its job fetch and description
      // enrichment use public guest endpoints.
      const JOB_LOGIN_IDS = getJobAuthPreflightSourceIds(
        ids => ids.filter(platformId => runActiveEnabledSourceIds.includes(platformId)),
      );
      const notLoggedIn = (await Promise.all(
        JOB_LOGIN_IDS.map(async (platformId) => {
          const res = await window.electronAPI.checkJobPlatformAuth?.({ platformId });
          if (res?.connected) return null;
          return JOB_SOURCE_BY_ID[platformId]?.name || platformId;
        })
      )).filter(Boolean);
      if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunIdRef.current });
      if (notLoggedIn.length > 0) {
        throw Object.assign(
          new Error(`Log in to ${notLoggedIn.join(', ')} first (Settings → Job Platform Logins)`),
          { isLoginGate: true, notLoggedIn }
        );
      }

      // A retained profile/files field is not a fresh Board capability. Claim
      // only the exact token saved in this Board's durable plan, at the actual
      // lane turn; a reload of that same Board may re-enter its already-owned
      // token, but a failed/reset older import cannot silently become new work.
      if (queueManagedByBoard && freshImportCapability) {
        const importAdmission = jobCareerImportBoardAdmission(laneTurnData, {
          capability: freshImportCapability,
          boardRunId,
          nodeId: currentId,
        });
        if (importAdmission.kind === 'missing') {
          return searchRunOutcome('not-ready', {
            error: 'This Job Search no longer has the fresh career import reserved by this Job Board. Manually clear career data and import fresh files before starting a new search.',
          });
        }
        if (importAdmission.kind === 'fresh' || importAdmission.kind === 'reclaimable-unstarted') {
          const reclaimingLegacyUnstartedImport = importAdmission.kind === 'reclaimable-unstarted';
          const consumptionPatch = jobCareerImportConsumptionPatch({
            capability: freshImportCapability,
            boardRunId,
            origin: 'job-board',
          });
          updateGlobal(currentId, (node) => {
            const current = node?.data || {};
            // A pre-fix login rejection may have consumed this exact import
            // before it ever parsed files or touched a provider. Reclaim only
            // that helper-proven no-work shape, atomically replacing its old
            // Board receipt with this Board's new run id. Any started/partial
            // import remains ineligible for a new transaction.
            const canClaim = freshJobCareerImportCapability(current, { nodeId: currentId }) === freshImportCapability
              || retryableUnstartedJobCareerImportCapability(current, { nodeId: currentId }) === freshImportCapability;
            return canClaim
              ? consumptionPatch
              : null;
          });
          await waitForRendererCommitFrame();
          const committedImport = jobCareerImportBoardAdmission(getNode(currentId)?.data, {
            capability: freshImportCapability,
            boardRunId,
            nodeId: currentId,
          });
          if (committedImport.kind !== 'owned') {
            return searchRunOutcome('not-ready', {
              error: 'The fresh career import changed before this Job Board could start it.',
            });
          }
          if (reclaimingLegacyUnstartedImport) {
            EventLogger.log(
              `[JobSearch][${currentId}] Reclaimed legacy unstarted Board import for post-login retry board=${boardRunId}`,
            );
          }
        }
      } else if (!queueManagedByBoard) {
        // Standalone imports retain their one-shot provenance too. A later
        // Board connection therefore sees an attempted generation, not a new
        // import, even when this direct attempt fails before producing rows.
        const standaloneCapability = freshJobCareerImportCapability(laneTurnData, { nodeId: currentId });
        if (standaloneCapability) {
          updateGlobal(currentId, jobCareerImportConsumptionPatch({
            capability: standaloneCapability,
            origin: 'standalone',
          }));
        }
      }

      processingToken = processingRunsRef.current.start();
      if (!processingToken) {
        return searchRunOutcome('busy', { error: 'This Job Search module is already running.' });
      }
      if (cancelled()) return searchRunOutcome('cancelled');
      activeManualAiRunIdRef.current = effectiveManualAiRunId;

      // Destructive fresh-run setup belongs after queue admission. In
      // particular, do not clear the prior token/recovery fields while a direct
      // Search is merely waiting and can still become Board-managed.
      scrapeWarningsRef.current = [];
      pendingJobsRef.current = null;
      gatheredCountRef.current = 0;
      jobRunIdRef.current = null;
      sourceWarningOverridesDuringSearchRef.current.clear();
      updateGlobal(currentId, {
        pendingJobs: null,
        pendingTargetRole: null,
        pendingCareerData: null,
        pendingJobPreferences: null,
        pendingJobPreferencePlan: null,
        pendingJobPreferencesInterpretation: null,
        activeTargetRole: null,
        // Cleared alongside activeTargetRole — this run's own Step 2 (query
        // construction) recomputes and re-freezes the real value via
        // deriveSearchTitles before anything reads it. Without this, a
        // pending Solve racing the very start of a fresh run could otherwise
        // read the PRIOR run's title list for one tick.
        pinnedTitles: [],
        scrapeWarnings: [],
        jobRunId: null,
        // A previous collection-only/Test Mode completion is terminal, but its
        // unscored provenance belongs only to that generation. Clear it at the
        // fresh-run boundary so a later ordinary scored (or authoritative
        // zero-result) run can supply a Job Board input.
        aiSkipped: false,
        collectionOnly: false,
        testMode: false,
        _boardRollbackSourceProgressFence: null,
        rerunOutcome: null,
        rerunNotice: null,
        reanalysisNotice: null,
      });

      cancelCleanSourceCardDismiss();
      resetSourceProgress();
      // The hub-side reset above only clears OUR aggregate hook. Source cards hold
      // their own local count and a re-run keeps them on canvas, so broadcast a
      // reset to make every card drop the previous run's count now (else they paint
      // stale "{N} jobs" until each source's first fresh event arrives this run).
      document.dispatchEvent(new CustomEvent('job-source-progress-reset', { detail: { hubId: id } }));

      // Snapshot the node position so we can spawn siblings near it even if
      // the user navigates away and unmounts this layer of the canvas.
      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };

      updateGlobal(currentId, {
        errorMessage: null,
        rerunOutcome: null,
        rerunNotice: null,
        reanalysisNotice: null,
        testModeNote: null,
        resultDisposition: null,
        // Same reason as the ref above: a run reached through any entry point
        // other than handleRerun must not carry the previous run's token.
        jobRunId: null,
        locationSnapshot: runLocationSnapshot,
      });
      let profile = providedProfile;
      let resumeFingerprint = laneTurnData.resumeFingerprint || '';
      // The React Flow `data` closure cannot observe the just-parsed value
      // until a later render. Keep this run's career material local so every
      // following AI step sees the fresh files immediately.
      let activeCareerData = laneTurnData.careerData || '';

      // Spawn (or reuse) one platform card per active job source only after the
      // login gate passes. ensureSourceCards intentionally frames all source
      // cards, which must not replace the user's zoom/pan for a login request.
      ensureSourceCards({ frameSourceCards, sourceIds: runActiveEnabledSourceIds });

      // Step 1: Parse career data (only when fresh files were dropped). Any
      // number/type of files are transcribed + merged into one `careerData`
      // blob server-side; a structured `profile` is derived from the merge and
      // drives the rest of the pipeline exactly as the old single-resume profile
      // did. A re-drop always re-parses (it's an explicit user action); the
      // file-less re-search path below reuses the stored profile instead.
      if (paths.length > 0) {
        updateGlobal(currentId, { hubState: 'parsing' });
        const parseResult = await window.electronAPI.parseCareerData({
          filePaths: paths, nodeId: currentId, manualAiRunId: effectiveManualAiRunId,
        });
        if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunIdRef.current });
        if (!parseResult.success) {
          const err = new Error(parseResult.error || 'Failed to parse career files');
          throw err;
        }
        profile = parseResult.profile;
        resumeFingerprint = String(parseResult.fingerprint || '');
        activeCareerData = parseResult.careerData || '';

        updateGlobal(currentId, {
          hubState: 'querying',
          resumeProfile: profile,
          careerData: parseResult.careerData,
          resumeSummary: buildResumeSummary(profile),
          resumeFingerprint,
          resumeContext: {
            skills: profile.skills,
            experience: profile.experience_years,
          },
        });
      } else {
        updateGlobal(currentId, { hubState: 'querying' });
      }

      // Step 2: Query construction
      const activeTargetRole = String(laneTurnData.targetRole || '').trim();
      // Freeze the raw preference text and the AI's interpretation for this
      // run. A user may edit the textarea while scraping; that edit applies to
      // their next run, never halfway through this one. (In practice a locked
      // hub's brief is read-only anyway — see ROLE LOCKING below — but an
      // unmigrated/unlocked hub can still be mid-edit at click time.)
      const activeJobPreferences = String(laneTurnData.jobPreferences || '').trim();
      // ROLE LOCKING: resolveSearchRoles' two-pass resolution is the single
      // most expensive — and most important — AI work this module does, so it
      // must happen EXACTLY ONCE per hub, ever, and every later scan reuses
      // its output verbatim (no re-interpretation, no re-audit, no variance
      // between runs). `laneTurnData.resolvedRoles` is that durable lock:
      // once non-empty it wins outright and this run spends zero
      // interpretation calls. Only a hub that has never locked (fresh, or
      // just had its career data cleared — see handleClearCareerFiles/
      // resetHandler, the only two places allowed to blank these fields) pays
      // for the resolver, which may itself spend a second handoff (the
      // coverage/compliance audit) when the brief left titles for the AI to
      // determine — see jobPreferences.js's resolveSearchRoles for why
      // spending it here, once, amortized over every future re-scan, is the
      // right trade.
      let jobPreferencesInterpretation = laneTurnData.searchBriefPlan ?? null;
      // FIX 2: keyed on resolvedRolesMeta (see hasResolvedRoleLock), not
      // resolvedRoles.length — a legitimate zero-title resolution must still
      // count as locked, or this hub re-pays the resolver on every future run.
      const hasLockedRoles = hasResolvedRoleLock(laneTurnData);
      // Only set when THIS run performs the one-time resolution — merged into
      // the freeze update below so a reused lock leaves these fields alone.
      let freshRoleLockPatch = null;
      if (!hasLockedRoles && activeJobPreferences && window.electronAPI?.resolveSearchRoles) {
        updateGlobal(currentId, { hubState: 'interpreting-preferences' });
        const resolveResult = await window.electronAPI.resolveSearchRoles({
          jobPreferences: activeJobPreferences,
          profile,
          careerData: activeCareerData,
          nodeId: currentId,
          manualAiRunId: effectiveManualAiRunId,
        });
        if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunIdRef.current });
        if (resolveResult?.success === false) {
          const err = new Error(resolveResult.error || 'Failed to understand Job Preferences');
          throw err;
        }
        jobPreferencesInterpretation = resolveResult?.plan || null;
        const lockedTitles = Array.isArray(jobPreferencesInterpretation?.titles)
          ? jobPreferencesInterpretation.titles.filter(t => typeof t === 'string' && t.trim())
          : [];
        freshRoleLockPatch = {
          searchBriefPlan: jobPreferencesInterpretation,
          resolvedRoles: lockedTitles,
          resolvedRolesMeta: {
            derivedAt: new Date().toISOString(),
            // Diagnostic evidence only — null when the brief itself was
            // empty (pass 1's own aiSkipped short-circuit, so pass 2 never
            // ran; see resolveSearchRoles in jobPreferences.js). Persisted
            // because it can never be re-derived once locked: pass 2 never
            // runs again for this hub.
            roleAudit: resolveResult?.roleAudit || null,
          },
        };
      }
      // See deriveSearchTitles above: a legacy target role (unmigrated
      // canvas only) wins outright; otherwise this is the locked plan's
      // AI-determined `titles`, unconditionally — there is no separate gate
      // list anymore, so this one derivation feeds both the search queries
      // and (via `pinnedTitles` below) display. `activeSearchTitles` is also
      // what's persisted as `data.pinnedTitles` — JobBoardNode's moduleLabel
      // falls back to it (display/label purposes only) for a hub that hasn't
      // locked resolvedRoles yet. Frozen here alongside
      // activeTargetRole/activeJobPreferences and persisted so every later
      // reader of this run (the USAJobs background refresh, a paused-source
      // Solve/Resume) sees the same list this run started with.
      const activeSearchTitles = deriveSearchTitles(activeTargetRole, jobPreferencesInterpretation);
      updateGlobal(currentId, {
        hubState: 'querying',
        activeTargetRole,
        activeJobPreferences,
        jobPreferencePlan: jobPreferencesInterpretation,
        jobPreferencesInterpretation,
        pinnedTitles: activeSearchTitles,
        ...(freshRoleLockPatch || {}),
      });
      const activePreferredLocation = locationToLegacyText(runLocationSnapshot.searchLocation);
      const queryCacheKey = buildQueryCacheKey({
        resumeFingerprint,
        jobPreferences: activeJobPreferences,
        preferredLocation: activePreferredLocation,
      });
      const canReuseQueries = !!(
        profile &&
        laneTurnData.queries &&
        laneTurnData.queryCacheKey &&
        laneTurnData.queryCacheKey === queryCacheKey
      );
      let queriesResult = null;
      if (canReuseQueries) {
        queriesResult = {
          success: true,
          queries: laneTurnData.queries,
          queryModel: laneTurnData.queryModel || null,
        };
        EventLogger.log(`[JobSearch][${currentId}] Resume/query inputs unchanged — reusing stored search queries`);
      } else if (activeTargetRole) {
        // Do not pay a query-generation model to create work we do not want.
        // Location correction/country inference is a separate, location-only
        // operation; the scrape bundle itself is constructed deterministically.
        const locationResult = await window.electronAPI.resolveJobSearchLocation({
          profile,
          nodeId: currentId,
          manualAiRunId: effectiveManualAiRunId,
          preferredLocation: activePreferredLocation,
        });
        if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunIdRef.current });
        if (!locationResult.success) {
          const err = new Error(locationResult.error || 'Failed to resolve search location');
          throw err;
        }
        queriesResult = {
          success: true,
          queries: buildExactTargetRoleQueryBundle(activeTargetRole),
          queryModel: null,
          canonicalLocation: locationResult.canonicalLocation,
          canonicalCountry: locationResult.canonicalCountry || '',
        };
        EventLogger.log(`[JobSearch][${currentId}] Target role set — skipping query variation generation and searching exactly "${activeTargetRole}"`);
      } else if (activeSearchTitles.length > 0) {
        // No target role, but Job Preferences interpretation already produced
        // `titles` — either copied verbatim from the brief or worked out by
        // the AI from the brief + career profile (deriveSearchTitles doesn't
        // care which; both are searched the same way). Build the bundle
        // locally instead of paying for a second model call
        // (generateJobQueries): this removes one human copy/paste handoff
        // per brief-driven run, since every AI call in this app is a manual
        // paste-back with no timeout. Still resolve the location exactly as
        // the target-role branch above does — that is a separate,
        // location-only operation.
        const locationResult = await window.electronAPI.resolveJobSearchLocation({
          profile,
          nodeId: currentId,
          manualAiRunId: effectiveManualAiRunId,
          preferredLocation: activePreferredLocation,
        });
        if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunIdRef.current });
        if (!locationResult.success) {
          const err = new Error(locationResult.error || 'Failed to resolve search location');
          throw err;
        }
        queriesResult = {
          success: true,
          queries: buildPinnedTitleQueryBundle(activeSearchTitles),
          queryModel: null,
          canonicalLocation: locationResult.canonicalLocation,
          canonicalCountry: locationResult.canonicalCountry || '',
        };
        EventLogger.log(`[JobSearch][${currentId}] Job Preferences produced ${activeSearchTitles.length} title(s) — skipping query generation and searching them directly: ${activeSearchTitles.join(', ')}`);
      } else {
        queriesResult = await window.electronAPI.generateJobQueries({
          profile, nodeId: currentId, targetRole: activeTargetRole, preferredLocation: activePreferredLocation,
          careerData: activeCareerData,
          jobPreferences: activeJobPreferences,
          preferencePlan: jobPreferencesInterpretation,
          jobPreferencesInterpretation,
          manualAiRunId: effectiveManualAiRunId,
        });
        if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunIdRef.current });
        if (!queriesResult.success) {
          const err = new Error(queriesResult.error || 'Failed to generate queries');
          throw err;
        }
      }
      const allQueries = flattenJobSearchQueries(queriesResult.queries);
      const queryModel = queriesResult.queryModel || null;
      // The location resolver (or the exploratory query call when role is blank)
      // normalizes free-form locations so board filters do not receive a typo.
      // On a cache hit reuse the persisted canonical; raw input is the fallback.
      const canonicalLocation =
        (canReuseQueries ? laneTurnData.canonicalLocation : queriesResult.canonicalLocation)
        || activePreferredLocation;
      // Survives a remote-only search, where canonicalLocation is deliberately
      // empty. Used only to pin a board's MARKET (never to narrow the search).
      // Fall through to the fresh result rather than short-circuiting on the
      // cache branch: a canvas created before canonicalCountry existed has none
      // stored, and `canReuseQueries ? data.x : y` would then yield '' forever,
      // silently un-pinning the market on every reused run.
      const canonicalCountry =
        (canReuseQueries ? laneTurnData.canonicalCountry : '')
        || queriesResult.canonicalCountry
        || laneTurnData.canonicalCountry
        || '';

      // Step 3: Search
      sourceWarningOverridesDuringSearchRef.current.clear();
      updateGlobal(currentId, {
        hubState: 'searching',
        queryCount: allQueries.length,
        queries: queriesResult.queries,
        queryModel,
        queryCacheKey,
        canonicalLocation,
        canonicalCountry,
        resumeFingerprint,
        collectionScopeCaveats: [],
      });
      const searchResult = await window.electronAPI.searchJobs({
        queries: allQueries,
        nodeId: currentId,
        maxAgeDays: laneTurnData.maxAgeDays || 21,
        collectionLimits: runCollectionLimits,
        enabledSourceIds: runEnabledSourceIds,
        canvasFilePath,
        preferredLocation: canonicalLocation,
        // The user's ORIGINAL free-form input (e.g. "denvr") — telemetry only, so
        // the bug report can show the typo-correction (denvr → Denver, CO) it
        // can't otherwise see (only the canonical is used for the actual search).
        rawLocation: activePreferredLocation,
        // Candidate's own locations — the keyword-less company-board sources
        // (Greenhouse/Lever/RemoteOK/WWR) must NOT treat the city baked into a
        // job title as role relevance, or a Denver cinematographer pulls in
        // every Denver SWE/sales posting at Datadog et al.
        profileLocations: profile?.locations || [],
        // There is no deterministic post-search title gate anymore —
        // jobs.js's old applyPinnedTitleGate is gone, and this call no
        // longer sends a `pinnedTitles` parameter. Role relevance for every
        // source's gathered rows, gated or not before, is now judged the
        // same way: the AI role screen inside per-listing preference
        // evaluation (main process, fails open). `targetRole` is still sent,
        // but for back-compat/display only — it is legacy-only
        // data.targetRole from an unmigrated canvas, never written by the
        // current UI, and no longer used to filter anything here.
        targetRole: activeTargetRole,
        jobPreferences: activeJobPreferences,
        jobPreferencePlan: jobPreferencesInterpretation,
        preferencePlan: jobPreferencesInterpretation,
        jobPreferencesInterpretation,
        // Country only, kept separate from preferredLocation so a remote-only
        // search still pins which country's market a board serves.
        countryScope: canonicalCountry,
        // The manifest stores this opaque full-parse fingerprint. It is the
        // recovery identity for the exact career material used by this run.
        profileFingerprint: normalizeResumeProfileFingerprint(resumeFingerprint),
        runOrigin,
        profileInputMode: paths.length > 0 ? 'fresh-files' : 'stored-profile',
      });
      if (cancelled()) return searchRunOutcome('cancelled', { runId: jobRunIdRef.current });

      // Dice API hard failure: retries exhausted on 5xx — abort entire pipeline.
      if (!searchResult.success && searchResult.diceApiDown) {
        throw new Error(searchResult.error || 'Dice API is unavailable — search cancelled');
      }

      // Backend login gate: if any browser-scraped platform isn't connected
      // the search handler returns early with notLoggedIn instead of running.
      if (!searchResult.success && Array.isArray(searchResult.notLoggedIn) && searchResult.notLoggedIn.length > 0) {
        const names = searchResult.notLoggedIn.map(loginId => JOB_SOURCE_BY_ID[loginId]?.name || loginId);
        throw Object.assign(
          new Error(`Log in to ${names.join(', ')} first (Settings → Job Platform Logins)`),
          { isLoginGate: true, notLoggedIn: searchResult.notLoggedIn }
        );
      }
      // Any other failure shape (e.g. noPlatformsSelected, or a bare thrown error
      // caught generically by handleSafe) must not fall through to foundJobs=[] —
      // that reads identically to a genuine zero-result search and the error is lost.
      if (!searchResult.success) {
        throw new Error(searchResult.error || 'Job search failed');
      }
      const searchWarnings = Array.isArray(searchResult.scrapeWarnings) ? searchResult.scrapeWarnings : [];
      // Reconcile the backend's stale final list with source actions that
      // completed while it was still gathering. Failed attempts have no
      // override, so they can never accidentally suppress this final warning.
      const sourceWarningOverrides = sourceWarningOverridesDuringSearchRef.current;
      const effectiveWarnings = reconcileJobSourceWarnings(searchWarnings, sourceWarningOverrides);
      const blockingWarnings = effectiveWarnings.filter(isJobSourceWarningGating);

      // Merge backend's foundJobs with any jobs already resolved via paste during
      // the search — they're in pendingJobsRef but absent from the backend result.
      // Resolved items go FIRST: the dedup is first-wins, and on a collision the
      // resolved copy is the one carrying work the user paid for mid-run (a
      // LinkedIn Solve's enriched descriptions) while the backend copy of the
      // same posting is the pre-enrichment one.
      let foundJobs = (searchResult.success && Array.isArray(searchResult.jobs)) ? searchResult.jobs : [];
      // `gatheredCount` is the source-card-aligned collection total. `rawCount`
      // remains the broader provider funnel used only for diagnostics; retain it
      // as a backwards-compatible fallback for an older main-process response.
      const visibleGatheredCount = searchResult.gatheredCount ?? searchResult.rawCount ?? foundJobs.length;
      if (sourceWarningOverrides.size > 0) {
        const prevPending = Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current : [];
        const resolvedItems = prevPending.filter(j => sourceWarningOverrides.has(j?.source));
        if (resolvedItems.length > 0) {
          foundJobs = dedupJobsAcrossSources([...resolvedItems, ...foundJobs]);
        }
      }

      // Disposition the search result: pause in 'sources-ready' on a gating
      // warning, or terminate 'done' when empty (block-gate MUST precede empty —
      // see handlePostSearchResult). Only proceed to score when neither fires.
      const postSearchResult = await handlePostSearchResult({
        currentId, foundJobs, warnings: effectiveWarnings, blockingWarnings,
        profile, activeTargetRole, activeJobPreferences, jobPreferencesInterpretation,
        careerData: activeCareerData, canvasFilePath,
        jobRunId: searchResult.runId || null,
        locationSnapshot: runLocationSnapshot,
        descriptionRecoveryJobs: Array.isArray(searchResult.descriptionRecoveryJobs)
          ? searchResult.descriptionRecoveryJobs
          : null,
        descriptionRecoveryState: searchResult.descriptionRecoveryState || null,
        collectionScopeCaveats: searchResult.collectionScopeCaveats,
        gatheredCount: visibleGatheredCount,
        sourceIds: runActiveEnabledSourceIds,
        cancelled,
      });
      if (!postSearchResult.shouldScore) {
        if (postSearchResult.outcome?.status !== 'cancelled') {
          await completeManualAiRun(effectiveManualAiRunId);
        }
        if (cancelled()) {
          return searchRunOutcome('cancelled', { runId: searchResult.runId || null });
        }
        return postSearchResult.outcome || searchRunOutcome('failed', {
          runId: searchResult.runId || null,
          error: 'The search stopped without a terminal result.',
        });
      }
      const finalWarnings = postSearchResult.warnings;
      const finalCollectionScopeCaveats = normalizeCollectionScopeCaveats(searchResult.collectionScopeCaveats);

      const preferenceResult = await evaluatePreferencesForRun({
        jobs: foundJobs,
        profile,
        careerData: activeCareerData,
        activeTargetRole,
        activeJobPreferences,
        jobPreferencesInterpretation,
        locationSnapshot: runLocationSnapshot,
        manualAiRunId: effectiveManualAiRunId,
      });
      if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult.runId || null });
      foundJobs = preferenceResult.jobs;
      if (foundJobs.length === 0) {
        // Preserve the full post-history candidate pool even when strict Job
        // Preferences remove every row. It lets a later preference edit
        // re-evaluate without scraping the same listings again.
        try {
          await window.electronAPI?.saveJobAnalysisSnapshot?.({
            jobs: preferenceResult.candidatePool,
            profile,
            careerData: activeCareerData,
            nodeId: currentId,
            targetRole: activeTargetRole,
            jobPreferences: activeJobPreferences,
            jobPreferencePlan: jobPreferencesInterpretation,
            preferenceEvaluation: preferenceResult.evaluation,
            preferenceCandidatePool: preferenceResult.candidatePool,
            snapshotContext: {
              sourceHubId: currentId,
              runId: searchResult.runId || null,
              canvasFilePath,
              resumeSummary: buildResumeSummary(profile),
              sourceGatheredCount: visibleGatheredCount,
              searchLocation: runLocationSnapshot.searchLocation,
              remoteResidences: runLocationSnapshot.remoteResidences,
            },
          });
        } catch (err) {
          EventLogger.error(`[JobSearch][${currentId}] Failed to save preference-filtered snapshot:`, err);
        }
        if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult.runId || null });
        const completion = searchResult.runId
          ? await completeJobRun(searchResult.runId, 'completed', 'preference-filtered', canvasFilePath, 0, moduleFingerprint([]), cancelled)
          : null;
        if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult.runId || null });
        const finalizationError = terminalFinalizationError(searchResult.runId, canvasFilePath, completion);
        updateGlobal(currentId, {
          hubState: 'done', scoredJobs: [], finalSourceCounts: {}, resultCount: 0,
          totalScoredCount: 0, scrapedCount: 0, gatheredCount: visibleGatheredCount,
          jobRunId: searchResult.runId || null,
          preferenceMatchedCount: preferenceResult.matchedCount,
          preferenceFilteredCount: preferenceResult.filteredCount,
          preferenceEvaluation: preferenceResult.evaluation,
          preferenceCandidatePool: preferenceResult.candidatePool,
          pendingJobs: null, scrapeWarnings: finalWarnings,
          collectionScopeCaveats: normalizeCollectionScopeCaveats(finalCollectionScopeCaveats),
          resultDisposition: 'preference-filtered',
          errorMessage: finalizationError,
        });
        await completeManualAiRun(effectiveManualAiRunId);
        if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult.runId || null });
        return finalizationError
          ? searchRunOutcome('recovery-finalization-failed', {
            runId: searchResult.runId || null,
            resultDisposition: 'preference-filtered',
            error: finalizationError,
          })
          : searchRunOutcome('completed', {
            runId: searchResult.runId || null,
            resultDisposition: 'preference-filtered',
          });
      }

      if (SKIP_AI_FOR_TESTING) {
        try {
          await window.electronAPI?.saveJobAnalysisSnapshot?.({
            jobs: foundJobs,
            profile,
            careerData: activeCareerData,
            nodeId: currentId,
            targetRole: activeTargetRole,
            jobPreferences: activeJobPreferences,
            jobPreferencePlan: jobPreferencesInterpretation,
            preferenceEvaluation: preferenceResult.evaluation,
            preferenceCandidatePool: preferenceResult.candidatePool,
            snapshotContext: {
              sourceHubId: currentId,
              runId: searchResult.runId || null,
              canvasFilePath,
              resumeSummary: buildResumeSummary(profile),
              sourceGatheredCount: visibleGatheredCount,
              searchLocation: runLocationSnapshot.searchLocation,
              remoteResidences: runLocationSnapshot.remoteResidences,
              jobPreferences: activeJobPreferences,
              jobPreferencePlan: jobPreferencesInterpretation,
              preferenceCandidatePool: preferenceResult.candidatePool,
            },
          });
        } catch (err) {
          EventLogger.error(`[JobSearch][${currentId}] Failed to save test-mode prompt snapshot:`, err);
        }
        if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult.runId || null });
        EventLogger.log(`[JobSearch][${currentId}] SKIP_AI_FOR_TESTING — ${foundJobs.length} jobs collected, stopping before AI scoring`);
        // Collection-only runs do not create board cards, so they must not
        // enter seen-history. A normal scored run is recorded by the Job Board
        // only after its results have been displayed.
        const completion = searchResult.runId
          ? await completeJobRun(searchResult.runId, 'completed', 'collection-only', canvasFilePath, 0, moduleFingerprint([]), cancelled)
          : null;
        if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult.runId || null });
        const finalizationError = terminalFinalizationError(searchResult.runId, canvasFilePath, completion);
        updateGlobal(currentId, {
          hubState: 'done',
          scoredJobs: [],
          finalSourceCounts: {},
          resultCount: 0,
          scrapedCount: foundJobs.length,
          gatheredCount: visibleGatheredCount,
          preferenceMatchedCount: preferenceResult.matchedCount,
          preferenceFilteredCount: preferenceResult.filteredCount,
          preferenceEvaluation: preferenceResult.evaluation,
          preferenceCandidatePool: preferenceResult.candidatePool,
          testMode: true,
          aiSkipped: true,
          collectionOnly: true,
          resultDisposition: 'collection-only',
          totalScoredCount: 0,
          scoreRangeMin: 0,
          scoreRangeMax: 100,
          scoreThreshold: 0,
          scrapeWarnings: finalWarnings,
          collectionScopeCaveats: normalizeCollectionScopeCaveats(finalCollectionScopeCaveats),
          pendingJobs: null,
          jobRunId: searchResult.runId || null,
          testModeNote: `[Test mode] ${foundJobs.length} jobs collected — AI scoring disabled`,
          rerunOutcome: null,
          rerunNotice: null,
          errorMessage: finalizationError,
        });
        await completeManualAiRun(effectiveManualAiRunId);
        if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult.runId || null });
        return finalizationError
          ? searchRunOutcome('recovery-finalization-failed', {
            runId: searchResult.runId || null,
            resultDisposition: 'collection-only',
            error: finalizationError,
          })
          : searchRunOutcome('completed', {
            runId: searchResult.runId || null,
            resultDisposition: 'collection-only',
          });
      }

      return await runScoringAndSpawn({
        profile,
        careerData: activeCareerData,
        jobs: foundJobs,
        gatheredCount: visibleGatheredCount,
        scrapeWarnings: finalWarnings,
        collectionScopeCaveats: finalCollectionScopeCaveats,
        activeTargetRole,
        activeJobPreferences,
        jobPreferencesInterpretation,
        preferenceMatchedCount: preferenceResult.matchedCount,
        preferenceFilteredCount: preferenceResult.filteredCount,
        preferenceEvaluation: preferenceResult.evaluation,
        preferenceCandidatePool: preferenceResult.candidatePool,
        originalPos,
        jobRunId: searchResult.runId || null,
        cancelled,
        locationSnapshot: runLocationSnapshot,
        manualAiRunId: effectiveManualAiRunId,
      });
    } catch (error) {
      // The app-level manual-AI dialog aborts the backend before its DOM cancel
      // notification necessarily reaches this node. If the IPC rejection wins
      // that race, perform the exact Board rollback here while the ownership
      // record still exists; otherwise runForJobBoard's finally would clear the
      // record and the later UI notification would fall through to full Reset.
      if (queueManagedByBoard && isJobBoardUserCancellation(error)) {
        const control = boardRunControlRef.current;
        if (
          control
          && control.orchestratorNodeId === orchestratorNodeId
          && typeof cancelBoardRunRef.current === 'function'
        ) {
          let result;
          if (control.rollbackApplied) {
            await control.rollbackPromise;
            result = { runId: control.cancelledRunId || null };
          } else {
            result = await cancelBoardRunRef.current({
              orchestratorNodeId,
              boardRunId: control.boardRunId,
              reason: 'manual-ai-cancelled',
            });
          }
          return searchRunOutcome('cancelled', { runId: result?.runId || jobRunIdRef.current });
        }
      }
      // User cancelled (Reset) OR deleted the hub mid-pipeline. The
      // Node-deleted branch handles the race where the backend abort
      // settles BEFORE the unmount effect has bumped the epoch — without
      // it, we'd write a useless errorMessage onto data that's about to
      // be discarded and log a misleading "pipeline failed" line.
      if (cancelled() || isNodeDeletedAbort(error)) {
        return searchRunOutcome('cancelled', {
          runId: jobRunIdRef.current,
          ...(deletionBlockedAtLaneStart
            ? { error: 'This Job Search is pending deletion.' }
            : {}),
        });
      }
      if (!error?.isLoginGate) EventLogger.error('JobSearchNode pipeline failed:', error);
      // Revert to the logical step ('done' if any results exist on the
      // canvas, else 'empty') and surface the failure via errorMessage so
      // HubErrorBanner picks it up.
      // "Has results" = scored jobs are stored (the cascade now lives on a Job
      // Board Module, not as children of this hub), so a prior successful run
      // keeps 'done' on a later error; a never-completed hub falls back to 'empty'.
      const hubHasResults = (getNode(currentId)?.data?.scoredJobs?.length || 0) > 0;
      // Without this the banner is the ONLY record of the failure: a later bug
      // report shows the user clicking "Try Again" on a banner whose text was
      // never written anywhere, leaving the original failure undiagnosable.
      EventLogger.error(`[JobSearch][${currentId}] Pipeline failed — error banner raised (hubState → ${hubHasResults ? 'done' : 'empty'}): ${error?.message || String(error)}`);
      updateGlobal(currentId, {
        hubState: hubHasResults ? 'done' : 'empty',
        resultDisposition: hubHasResults ? 'incomplete' : null,
        errorMessage: error?.message || String(error),
        rerunOutcome: null,
        rerunNotice: null,
      });
      return searchRunOutcome('failed', {
        runId: jobRunIdRef.current,
        resultDisposition: hubHasResults ? 'incomplete' : null,
        error,
      });
    } finally {
      if (!queueManagedByBoard && getNode(currentId)) {
        updateGlobal(currentId, (node) => (
          node?.data?.queuedModuleRun?.label === 'Job search'
            ? { queuedModuleRun: null }
            : null
        ));
      }
      if (activeManualAiRunIdRef.current === effectiveManualAiRunId) {
        activeManualAiRunIdRef.current = null;
      }
      if (processingToken && isMountedRef.current && processingRunsRef.current.finish(processingToken)) {
        if (
          pendingUSAJobsRefreshRef.current
          && !isJobWorkflowDeletionPending(currentId)
        ) {
          pendingUSAJobsRefreshRef.current = false;
          setTimeout(() => {
            if (isMountedRef.current) {
              triggerUSAJobsBackgroundSearch();
            }
          }, 0);
        }
      }
      if (!queueManagedByBoard && localQueueAdmissionRef.current === admissionToken) {
        localQueueAdmissionRef.current = null;
      }
      if (lease) await waitForRendererCommitFrame();
      lease?.release();
    }
  }, [id, updateGlobal, getNode, getNodes, getEdges, canvasFilePath, data, collectionLimits, enabledSourceIds, activeEnabledSourceIds, ensureSourceCards, handlePostSearchResult, epoch, resetSourceProgress, runScoringAndSpawn, triggerUSAJobsBackgroundSearch, cancelCleanSourceCardDismiss, moduleRunQueue, isMountedRef, addToast, completeManualAiRun, completeJobRun, evaluatePreferencesForRun]);

  const startProcessing = useCallback((fileOrFiles, {
    frameSourceCards = true,
    runOrigin = 'initial',
    manualAiRunId = null,
    queueManagedByBoard = false,
    parentCancelled = null,
    orchestratorNodeId = null,
    boardRunId = null,
    freshImportCapability = null,
  } = {}) => {
    const filePaths = Array.isArray(fileOrFiles) ? fileOrFiles : (fileOrFiles ? [fileOrFiles] : []);
    return runPipeline({
      filePaths,
      frameSourceCards,
      runOrigin,
      manualAiRunId,
      queueManagedByBoard,
      parentCancelled,
      orchestratorNodeId,
      boardRunId,
      freshImportCapability,
    });
  }, [runPipeline]);
  const startProcessingWithProfile = useCallback(
    (profile, {
      frameSourceCards = true,
      runOrigin = 'initial',
      manualAiRunId = null,
      queueManagedByBoard = false,
      parentCancelled = null,
      orchestratorNodeId = null,
      boardRunId = null,
      freshImportCapability = null,
    } = {}) => runPipeline({
      profile,
      frameSourceCards,
      runOrigin,
      manualAiRunId,
      queueManagedByBoard,
      parentCancelled,
      orchestratorNodeId,
      boardRunId,
      freshImportCapability,
    }),
    [runPipeline],
  );

  /**
   * Resume the pipeline from the paused 'sources-ready' state. Picks up the
   * partial search results stored in data.pendingJobs and re-enters scoring.
   * Called either:
   *  - automatically when the user has resolved or skipped every blocking
   *    warning (drained via the job-source-skip listener below), or
   *  - manually via the "Score current results" button on the paused-state
   *    UI, which also clears any remaining scrapeWarnings before resuming.
   */
  const resumeScoring = useCallback(async ({ queueManagedExternally = false } = {}) => {
    if (isJobWorkflowDeletionPending(id)) return;
    if (hasPendingManualAiRetirement(getNode(id)?.data || {})) {
      return searchRunOutcome('not-ready', {
        error: 'Finish the older manual-AI cancellation cleanup before resuming scoring.',
      });
    }
    if (processingRunsRef.current.active) return;
    // A connected paused Search deliberately lets its source-card actions finish
    // the already-gathered generation. Fence only the distinct ownership race
    // where a standalone continuation waits in the lane and then becomes
    // Board-managed before its turn.
    const boardConnectedAtContinuationAdmission = !queueManagedExternally
      && isJobSearchConnectedToBoard(id, getNodes(), getEdges());
    const requestedData = getNode(id)?.data || data;
    const requestedJobRunId = jobRunIdRef.current || requestedData.jobRunId || null;
    if (
      findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())
      && !findJobSearchBoardPausedContinuationOwner(id, requestedJobRunId, getNodes(), getEdges())
    ) {
      return searchRunOutcome('paused', {
        runId: requestedJobRunId,
        error: 'The paused Job Search continuation is reserved by its Job Board.',
      });
    }
    const priorContinuationAdmission = scoringContinuationAdmissionRef.current;
    if (priorContinuationAdmission && !queueManagedExternally) {
      return searchRunOutcome('busy', {
        runId: requestedJobRunId,
        error: 'This paused Job Search continuation is already queued or running.',
      });
    }
    if (priorContinuationAdmission?.queueManagedExternally && queueManagedExternally) {
      return searchRunOutcome('busy', {
        runId: requestedJobRunId,
        error: 'This paused Job Search continuation is already running.',
      });
    }
    const continuationAdmissionToken = Symbol(`job-search-scoring-continuation:${id}`);
    scoringContinuationAdmissionRef.current = {
      token: continuationAdmissionToken,
      runId: requestedJobRunId,
      queueManagedExternally,
    };
    const ownsContinuationAdmission = () => (
      scoringContinuationAdmissionRef.current?.token === continuationAdmissionToken
    );
    const clearContinuationQueueMarker = () => updateGlobal(id, (node) => {
      const label = node?.data?.queuedModuleRun?.label;
      return label === 'Finishing resolved job search' || label === 'Scoring job results'
        ? { queuedModuleRun: null }
        : null;
    });
    if (queueManagedExternally && priorContinuationAdmission) {
      // The Source resolver owns the lane that a click-time continuation is
      // waiting behind. Adopt the continuation in-place and hide only that
      // obsolete queue receipt; the queued call will no-op when its turn comes.
      clearContinuationQueueMarker();
    }
    // Read the live refs, NOT data.pendingJobs/data.scrapeWarnings: onResolved
    // merges freshly-extracted items into pendingJobsRef and then calls this
    // synchronously, before React re-renders — so the data closure still holds
    // the pre-merge list. That was the "captcha resolve inline-extracted 15
    // jobs but only 1 got scored" bug (and why the cleared warnings weren't
    // persisted). The refs are updated on every render AND synchronously by the
    // resolve/skip handlers, so they're always at least as fresh as data.
    let pending = pendingJobsRef.current;
    let pausedGatheredCount = gatheredCountRef.current ?? (Array.isArray(pending) ? pending.length : 0);
    // A resolve handler can call this synchronously before React commits the
    // paused run's data.jobRunId. Keep every completion/snapshot write scoped to
    // the live run token, just like the pending jobs and warnings above.
    let activeJobRunId = requestedJobRunId;
    let profile = requestedData.resumeProfile;
    let pausedCareerData = requestedData.pendingCareerData ?? requestedData.careerData;
    if (!pending || !Array.isArray(pending) || pending.length === 0) {
      // This terminal branch does not acquire the scoring queue, but it still
      // awaits a snapshot and receipt. Own an epoch so Reset/unmount cannot
      // publish its stale done state after either await.
      const cancelled = epoch.start();
      let emptyContinuationLease = null;
      let standaloneEmptyContinuationClaimedByBoard = false;
      try {
        if (!queueManagedExternally) {
          emptyContinuationLease = await moduleRunQueue.acquireModuleRun({
            nodeId: id,
            kind: 'jobsearch',
            lane: 'job-search',
            priority: 'continuation',
            label: 'Finish resolved job search',
            onQueued: ({ position }) => updateGlobal(id, () => (
              ownsContinuationAdmission()
                ? { queuedModuleRun: { label: 'Finishing resolved job search', position } }
                : null
            )),
            onQueueUpdate: ({ position }) => updateGlobal(id, () => (
              ownsContinuationAdmission()
                ? { queuedModuleRun: { label: 'Finishing resolved job search', position } }
                : null
            )),
            onStart: () => {
              if (cancelled() || isJobWorkflowDeletionPending(id)) throw new Error('Node deleted');
              if (!ownsContinuationAdmission()) return;
              if (
                !boardConnectedAtContinuationAdmission
                && isJobSearchConnectedToBoard(id, getNodes(), getEdges())
              ) {
                standaloneEmptyContinuationClaimedByBoard = true;
                return;
              }
              updateGlobal(id, { queuedModuleRun: null });
            },
          });
        }
        if (!ownsContinuationAdmission()) {
          EventLogger.log(`[JobSearch][${id}] Superseded queued empty continuation skipped at its lane turn.`);
          return searchRunOutcome('superseded', { runId: requestedJobRunId });
        }
        if (standaloneEmptyContinuationClaimedByBoard) {
          clearContinuationQueueMarker();
          addToast({
            title: 'Run from Job Board',
            description: 'This queued scoring continuation was kept unchanged. Use its connected Job Board.',
            type: 'info',
          });
          return searchRunOutcome('not-ready', {
            error: 'This scoring continuation is now managed by a connected Job Board.',
          });
        }
        if (
          findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())
          && !findJobSearchBoardPausedContinuationOwner(id, requestedJobRunId, getNodes(), getEdges())
        ) {
          clearContinuationQueueMarker();
          return searchRunOutcome('paused', {
            runId: requestedJobRunId,
            error: 'This scoring continuation was reserved by its Job Board while queued.',
          });
        }
      const continuationData = getNode(id)?.data || null;
      const continuationRunId = jobRunIdRef.current || continuationData?.jobRunId || null;
      const continuationPending = pendingJobsRef.current;
      if (
        cancelled()
        || isJobWorkflowDeletionPending(id)
        || continuationData?.hubState !== 'sources-ready'
        || continuationRunId !== requestedJobRunId
        || (Array.isArray(continuationPending) && continuationPending.length > 0)
      ) {
        EventLogger.log(`[JobSearch][${id}] Empty scoring continuation changed while queued; completion skipped.`);
        return searchRunOutcome('superseded', { runId: requestedJobRunId });
      }
      pending = continuationPending;
      pausedGatheredCount = gatheredCountRef.current
        ?? (Array.isArray(continuationPending) ? continuationPending.length : 0);
      activeJobRunId = continuationRunId;
      profile = continuationData.resumeProfile;
      pausedCareerData = continuationData.pendingCareerData ?? continuationData.careerData;
      // Nothing was collected (every blocked source got skipped, or a resolve
      // yielded no items) — finish in the terminal empty 'done' state instead
      // of leaving the hub stuck on the paused 'sources-ready' screen. Needed
      // now that a 0-jobs-but-blocked run pauses in 'sources-ready' with an
      // empty pendingJobs (see the block gate in runPipeline).
      // This is a real terminal zero-result run, not merely a paused state.
      // Replace the prior analysis snapshot before painting the result so
      // snapshot-only bug-report diagnostics cannot describe an earlier run.
      // An empty target role is a deliberate frozen run input. `||` would
      // replace it with a role edited while the source warning was paused.
      const activeTargetRole = continuationData.pendingTargetRole
        ?? continuationData.activeTargetRole
        ?? continuationData.targetRole
        ?? '';
      const locationSnapshot = continuationData.locationSnapshot || {
        searchLocation: getSearchLocation({
          searchLocation: continuationData.searchLocation,
          preferredLocation: continuationData.preferredLocation,
          canonicalLocation: continuationData.canonicalLocation,
        }),
        remoteResidences: normalizeRemoteResidences(continuationData.remoteResidences),
      };
      try {
        const saved = await window.electronAPI?.saveJobAnalysisSnapshot?.({
          jobs: [],
          profile,
          careerData: pausedCareerData,
          nodeId: id,
          targetRole: activeTargetRole,
          snapshotContext: {
            sourceHubId: id,
            runId: activeJobRunId,
            canvasFilePath,
            resumeSummary: buildResumeSummary(profile),
            sourceGatheredCount: pausedGatheredCount,
            locationSnapshot,
            searchLocation: locationSnapshot.searchLocation || null,
            remoteResidences: locationSnapshot.remoteResidences || null,
          },
        });
        if (saved && !saved.saved) {
          EventLogger.error(`[JobSearch][${id}] Failed to save paused empty-run analysis snapshot: ${saved.error || 'unknown error'}`);
        }
      } catch (err) {
        // Snapshot persistence is diagnostic-only; a write failure must never
        // leave the user stuck in sources-ready after they skipped the final block.
        EventLogger.error(`[JobSearch][${id}] Failed to save paused empty-run analysis snapshot:`, err);
      }
      if (cancelled()) return;
      const terminalWarnings = Array.isArray(scrapeWarningsRef.current) ? scrapeWarningsRef.current : [];
      const completion = activeJobRunId
        ? await completeJobRun(activeJobRunId, 'completed', 'zero', canvasFilePath, 0, moduleFingerprint([]), cancelled)
        : null;
      if (cancelled()) return;
      const finalizationError = terminalFinalizationError(activeJobRunId, canvasFilePath, completion);
      updateGlobal(id, {
        hubState: 'done', scoredJobs: [], finalSourceCounts: {},
        jobCount: 0,
        resultCount: 0, totalScoredCount: 0, scrapedCount: 0, gatheredCount: pausedGatheredCount,
        scoreRangeMin: 0, scoreRangeMax: 100, scoreThreshold: 0,
        pendingJobs: null,
        pendingTargetRole: null,
        pendingJobPreferences: null,
        pendingJobPreferencePlan: null,
        pendingJobPreferencesInterpretation: null,
        pendingCareerData: null,
        scrapeWarnings: terminalWarnings,
        jobRunId: activeJobRunId,
        rerunOutcome: 'no-new-results',
        rerunNotice: null,
        resultDisposition: 'empty-complete',
        errorMessage: finalizationError,
      });
      pendingJobsRef.current = null;
      scrapeWarningsRef.current = terminalWarnings;
      hubStateRef.current = 'done';
      const outcome = finalizationError
        ? searchRunOutcome('recovery-finalization-failed', {
            runId: activeJobRunId,
            resultDisposition: 'empty-complete',
            error: finalizationError,
          })
        : searchRunOutcome('completed', {
            runId: activeJobRunId,
            resultDisposition: 'empty-complete',
          });
      return outcome.status === 'completed'
        ? await waitForCommittedSearchOutcome({ getNode, nodeId: id, outcome, cancelled })
        : outcome;
      } catch (error) {
        if (cancelled() || isNodeDeletedAbort(error)) {
          return searchRunOutcome('cancelled', { runId: requestedJobRunId });
        }
        EventLogger.error(`[JobSearch][${id}] Empty scoring continuation failed:`, error);
        return searchRunOutcome('failed', {
          runId: requestedJobRunId,
          error: error?.message || String(error),
        });
      } finally {
        if (ownsContinuationAdmission()) clearContinuationQueueMarker();
        if (ownsContinuationAdmission()) scoringContinuationAdmissionRef.current = null;
        if (emptyContinuationLease) await waitForRendererCommitFrame();
        emptyContinuationLease?.release();
      }
    }
    if (!profile) {
      if (ownsContinuationAdmission()) scoringContinuationAdmissionRef.current = null;
      return searchRunOutcome('not-ready', {
        runId: requestedJobRunId,
        error: 'This paused Job Search has no stored career profile.',
      });
    }
    let processingToken = null;
    const currentId = id;
    const cancelled = epoch.start();
    const manualAiRunId = createManualAiRunId(currentId);
    let lease = null;
    let standaloneContinuationClaimedByBoard = false;
    try {
      if (!queueManagedExternally) {
        lease = await moduleRunQueue.acquireModuleRun({
          nodeId: currentId,
          kind: 'jobsearch',
          lane: 'job-search',
          priority: 'continuation',
          label: 'Job scoring',
          onQueued: ({ position }) => {
            updateGlobal(currentId, () => (
              ownsContinuationAdmission()
                ? { queuedModuleRun: { label: 'Scoring job results', position } }
                : null
            ));
          },
          onQueueUpdate: ({ position }) => {
            updateGlobal(currentId, () => (
              ownsContinuationAdmission()
                ? { queuedModuleRun: { label: 'Scoring job results', position } }
                : null
            ));
          },
          onStart: () => {
            if (cancelled() || isJobWorkflowDeletionPending(currentId)) throw new Error('Node deleted');
            if (!ownsContinuationAdmission()) return;
            if (
              !boardConnectedAtContinuationAdmission
              && isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())
            ) {
              standaloneContinuationClaimedByBoard = true;
              return;
            }
            updateGlobal(currentId, { queuedModuleRun: null });
          },
        });
      } else {
        updateGlobal(currentId, { queuedModuleRun: null });
      }
      if (!ownsContinuationAdmission()) {
        EventLogger.log(`[JobSearch][${id}] Superseded queued scoring continuation skipped at its lane turn.`);
        return searchRunOutcome('superseded', { runId: requestedJobRunId });
      }
      if (standaloneContinuationClaimedByBoard) {
        clearContinuationQueueMarker();
        addToast({
          title: 'Run from Job Board',
          description: 'This queued scoring continuation was kept unchanged. Use its connected Job Board.',
          type: 'info',
        });
        return searchRunOutcome('not-ready', {
          error: 'This scoring continuation is now managed by a connected Job Board.',
        });
      }
      if (
        findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())
        && !findJobSearchBoardPausedContinuationOwner(currentId, requestedJobRunId, getNodes(), getEdges())
      ) {
        clearContinuationQueueMarker();
        return searchRunOutcome('paused', {
          runId: requestedJobRunId,
          error: 'This scoring continuation was reserved by its Job Board while queued.',
        });
      }
      const continuationData = getNode(currentId)?.data || null;
      const continuationRunId = jobRunIdRef.current || continuationData?.jobRunId || null;
      const continuationPending = pendingJobsRef.current;
      if (
        cancelled()
        || isJobWorkflowDeletionPending(currentId)
        || continuationData?.hubState !== 'sources-ready'
        || continuationRunId !== requestedJobRunId
        || !Array.isArray(continuationPending)
        || continuationPending.length === 0
      ) {
        EventLogger.log(`[JobSearch][${id}] Scoring continuation changed while queued; scoring skipped.`);
        return searchRunOutcome('superseded', { runId: requestedJobRunId });
      }
      pending = continuationPending;
      pausedGatheredCount = gatheredCountRef.current ?? continuationPending.length;
      activeJobRunId = continuationRunId;
      profile = continuationData.resumeProfile;
      pausedCareerData = continuationData.pendingCareerData ?? continuationData.careerData;
      if (!profile) {
        return searchRunOutcome('not-ready', {
          runId: activeJobRunId,
          error: 'This paused Job Search has no stored career profile.',
        });
      }
      processingToken = processingRunsRef.current.start();
      if (!processingToken) return;
      activeManualAiRunIdRef.current = manualAiRunId;
      updateGlobal(currentId, {
        errorMessage: null,
        rerunOutcome: null,
        rerunNotice: null,
        reanalysisNotice: null,
      });
      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
      // Preserve a deliberately blank role from the paused run; only absent
      // legacy state may fall back to the editable next-run control.
      const activeTargetRole = continuationData.pendingTargetRole
        ?? continuationData.activeTargetRole
        ?? continuationData.targetRole
        ?? '';
      const activeJobPreferences = continuationData.pendingJobPreferences
        ?? continuationData.jobPreferences
        ?? '';
      const jobPreferencesInterpretation = continuationData.pendingJobPreferencesInterpretation
        ?? continuationData.pendingJobPreferencePlan
        ?? continuationData.jobPreferencePlan
        ?? continuationData.jobPreferencesInterpretation
        ?? null;
      const locationSnapshot = continuationData.locationSnapshot || {
        searchLocation: getSearchLocation(continuationData),
        remoteResidences: normalizeRemoteResidences(continuationData.remoteResidences),
      };
      const preferenceResult = await evaluatePreferencesForRun({
        jobs: pending,
        profile,
        careerData: pausedCareerData,
        activeTargetRole,
        activeJobPreferences,
        jobPreferencesInterpretation,
        locationSnapshot,
        manualAiRunId,
      });
      if (cancelled()) return;
      if (preferenceResult.jobs.length === 0) {
        try {
          await window.electronAPI?.saveJobAnalysisSnapshot?.({
            jobs: preferenceResult.candidatePool,
            profile,
            careerData: pausedCareerData,
            nodeId: currentId,
            targetRole: activeTargetRole,
            jobPreferences: activeJobPreferences,
            jobPreferencePlan: jobPreferencesInterpretation,
            preferenceEvaluation: preferenceResult.evaluation,
            preferenceCandidatePool: preferenceResult.candidatePool,
            snapshotContext: {
              sourceHubId: currentId,
              runId: activeJobRunId,
              canvasFilePath,
              resumeSummary: buildResumeSummary(profile),
              sourceGatheredCount: pausedGatheredCount,
              locationSnapshot,
              searchLocation: locationSnapshot.searchLocation,
              remoteResidences: locationSnapshot.remoteResidences,
            },
          });
        } catch (err) {
          EventLogger.error(`[JobSearch][${currentId}] Failed to save paused preference-filtered snapshot:`, err);
        }
        if (cancelled()) return;
        const completion = activeJobRunId
          ? await completeJobRun(activeJobRunId, 'completed', 'preference-filtered', canvasFilePath, 0, moduleFingerprint([]), cancelled)
          : null;
        if (cancelled()) return;
        updateGlobal(currentId, {
          hubState: 'done', scoredJobs: [], finalSourceCounts: {}, resultCount: 0, totalScoredCount: 0,
          scrapedCount: 0, gatheredCount: pausedGatheredCount,
          preferenceMatchedCount: preferenceResult.matchedCount,
          preferenceFilteredCount: preferenceResult.filteredCount,
          preferenceEvaluation: preferenceResult.evaluation,
          preferenceCandidatePool: preferenceResult.candidatePool,
          pendingJobs: null, pendingCareerData: null,
          pendingTargetRole: null, pendingJobPreferences: null,
          pendingJobPreferencePlan: null, pendingJobPreferencesInterpretation: null,
          resultDisposition: 'preference-filtered',
          errorMessage: terminalFinalizationError(activeJobRunId, canvasFilePath, completion),
        });
        await completeManualAiRun(manualAiRunId);
        const completionError = terminalFinalizationError(activeJobRunId, canvasFilePath, completion);
        const outcome = completionError
          ? searchRunOutcome('recovery-finalization-failed', {
              runId: activeJobRunId,
              resultDisposition: 'preference-filtered',
              error: completionError,
            })
          : searchRunOutcome('completed', {
              runId: activeJobRunId,
              resultDisposition: 'preference-filtered',
            });
        return outcome.status === 'completed'
          ? await waitForCommittedSearchOutcome({ getNode, nodeId: currentId, outcome, cancelled })
          : outcome;
      }
      const outcome = await runScoringAndSpawn({
        profile,
        careerData: pausedCareerData,
        jobs: preferenceResult.jobs,
        gatheredCount: pausedGatheredCount,
        scrapeWarnings: Array.isArray(scrapeWarningsRef.current) ? scrapeWarningsRef.current : [],
        activeTargetRole,
        activeJobPreferences,
        jobPreferencesInterpretation,
        preferenceMatchedCount: preferenceResult.matchedCount,
        preferenceFilteredCount: preferenceResult.filteredCount,
        preferenceEvaluation: preferenceResult.evaluation,
        preferenceCandidatePool: preferenceResult.candidatePool,
        originalPos,
        jobRunId: activeJobRunId,
        cancelled,
        locationSnapshot,
        manualAiRunId,
      });
      return outcome?.status === 'completed'
        ? await waitForCommittedSearchOutcome({ getNode, nodeId: currentId, outcome, cancelled })
        : outcome;
    } catch (error) {
      if (cancelled() || isNodeDeletedAbort(error)) return;
      EventLogger.error('[JobSearch] Resume scoring failed:', error);
      updateGlobal(currentId, {
        hubState: 'sources-ready',
        errorMessage: error?.message || String(error),
        rerunOutcome: null,
        rerunNotice: null,
      });
      return searchRunOutcome('failed', {
        runId: activeJobRunId,
        error: error?.message || String(error),
      });
    } finally {
      if (ownsContinuationAdmission()) clearContinuationQueueMarker();
      if (ownsContinuationAdmission()) scoringContinuationAdmissionRef.current = null;
      if (activeManualAiRunIdRef.current === manualAiRunId) activeManualAiRunIdRef.current = null;
      if (processingToken && isMountedRef.current && processingRunsRef.current.finish(processingToken)) {
        if (
          pendingUSAJobsRefreshRef.current
          && !isJobWorkflowDeletionPending(currentId)
        ) {
          pendingUSAJobsRefreshRef.current = false;
          setTimeout(() => {
            if (isMountedRef.current) {
              triggerUSAJobsBackgroundSearch();
            }
          }, 0);
        }
      }
      if (lease) await waitForRendererCommitFrame();
      lease?.release();
    }
  }, [addToast, id, data, canvasFilePath, epoch, getEdges, getNode, getNodes, runScoringAndSpawn, updateGlobal, triggerUSAJobsBackgroundSearch, moduleRunQueue, isMountedRef, completeJobRun, completeManualAiRun, evaluatePreferencesForRun]);

  useEffect(() => {
    resumeScoringRef.current = resumeScoring;
  }, [resumeScoring]);

  // ── Crash/quit recovery: detect an incomplete prior run + offer to resume ────
  // On load (and whenever the canvas file changes) ask the main process whether a
  // recent, unfinished job run left staged jobs next to the canvas. If so, surface
  // a non-blocking banner; Resume recovers the staged jobs and continues scoring,
  // Dismiss clears the sidecars. See electron/ipc/jobRunStaging.js.
  const [resumeOffer, setResumeOffer] = useState(null);
  const activeResumeLocation = normalizeLocationInput(data.canonicalLocation || data.preferredLocation || '').boardReady;
  const offeredResumeLocation = normalizeLocationInput(resumeOffer?.canonicalLocation || '').boardReady;
  const canResumeOffer = !!resumeOffer?.locationRecorded && activeResumeLocation === offeredResumeLocation;
  const activeResumeFingerprint = normalizeResumeProfileFingerprint(data.resumeFingerprint);
  const offeredResumeFingerprint = normalizeResumeProfileFingerprint(resumeOffer?.profileFingerprint);
  const resumeProfileMatches = !!activeResumeFingerprint
    && !!offeredResumeFingerprint
    && activeResumeFingerprint === offeredResumeFingerprint;
  // canResumeOffer is only the LOCATION gate. Resuming also needs the persisted
  // profile and the run's staged queries — handleResumeRun's `!profile ||
  // queries.length === 0` branch silently discards the staged run, so a button
  // offered without both is a trap that destroys what it promises to recover.
  const resumeRunActionable = canResumeOffer
    && resumeOffer?.resumable !== false
    && resumeOffer?.nodeId === id
    && hasReusableCareerProfile
    && resumeProfileMatches
    && ((resumeOffer?.queries?.length ?? 0) > 0);
  useEffect(() => {
    if (!canvasFilePath || !window.electronAPI?.peekJobRun) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const info = await window.electronAPI.peekJobRun({ canvasFilePath, nodeId: id });
        // An explicit career-file clear is a durable tombstone for recovery
        // material that began at or before it. `peekJobRun` is hub-scoped, but
        // retain the exact owner check before deleting: node-less legacy and
        // other-hub offers must never be touched from this component. The
        // token+owner discard is itself checked under the main-process
        // manifest lock, so a newer run that replaced this one is protected.
        const clearedAt = careerClearWatermarkRef.current;
        const startedAt = normalizeJobAnalysisClearWatermark(info?.startedAt);
        const staleClearedOwnedRun = info?.found
          && info?.nodeId === id
          && typeof info?.runId === 'string'
          && info.runId.length > 0
          && clearedAt != null
          && startedAt != null
          && startedAt <= clearedAt;
        if (staleClearedOwnedRun) {
          // Do not await this cleanup from the offer path. The clear intent is
          // already durable, and keeping the stale manifest visible while a
          // best-effort deletion settles invites an accidental resume.
          void Promise.resolve(
            window.electronAPI?.discardJobRun?.({ canvasFilePath, nodeId: id, runId: info.runId }),
          ).catch(() => {});
          return;
        }
        // The run sidecar is hub-scoped. A node-less legacy manifest is the
        // one deliberate exception: surface
        // a Start fresh-only offer so its unknown-owner staging can be cleared
        // through the dedicated owner-unknown IPC (never the normal hub path).
        if (!cancelled) setResumeOffer(
          info?.found && (info?.nodeId === id || !info?.nodeId) ? info : null,
        );
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [canvasFilePath, id, data.jobAnalysisClearedAt]);

  const handleResumeRun = useCallback(async (options = {}) => {
    const cfp = canvasFilePath;
    const queueManagedByBoard = options?.queueManagedByBoard === true;
    const parentCancelled = options?.parentCancelled;
    const orchestratorNodeId = options?.orchestratorNodeId || null;
    if (isJobWorkflowDeletionPending(id)) {
      return searchRunOutcome('cancelled', { error: 'This Job Search is pending deletion.' });
    }
    if (!queueManagedByBoard && deferDirectSearchToBoard('Interrupted-run resume')) {
      return searchRunOutcome('not-ready', { error: 'Resume this connected search from its Job Board.' });
    }
    if (!queueManagedByBoard && findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())) {
      addToast({
        title: 'Resume from Job Board',
        description: 'This interrupted Search is reserved by its Job Board. Finish or cancel that Board first.',
        type: 'info',
      });
      return searchRunOutcome('paused', {
        error: 'This interrupted Search is reserved by its Job Board.',
      });
    }
    let offer = options?.offer || resumeOffer;
    if (options?.discoverForBoard === true) {
      if (!window.electronAPI?.peekJobRun) {
        return searchRunOutcome('failed', { error: 'Interrupted Job Search recovery is unavailable.' });
      }
      try {
        const discovered = await window.electronAPI.peekJobRun({ canvasFilePath: cfp, nodeId: id });
        if (discovered?.success === false) {
          return searchRunOutcome('recovery-inspection-failed', {
            error: discovered.error || 'Could not inspect the interrupted Job Search.',
          });
        }
        if (
          !discovered?.found
          || discovered?.nodeId !== id
          || typeof discovered?.runId !== 'string'
          || !discovered.runId
        ) {
          return searchRunOutcome('not-found');
        }
        if (
          typeof options?.expectedRunId === 'string'
          && options.expectedRunId
          && discovered.runId !== options.expectedRunId
        ) {
          return searchRunOutcome('recovery-inspection-failed', {
            runId: options.expectedRunId,
            error: 'The staged Job Search run no longer matches the Job Board continuation.',
          });
        }
        if (typeof options?.onDiscoveredRun === 'function') {
          options.onDiscoveredRun(discovered);
        }
        if (!discovered.resumable) {
          return searchRunOutcome('stale-recovery-found', { runId: discovered.runId });
        }
        offer = discovered;
        if (typeof parentCancelled === 'function' && parentCancelled()) {
          return searchRunOutcome('cancelled', { runId: offer.runId || null });
        }
      } catch (error) {
        return searchRunOutcome('recovery-inspection-failed', {
          error: error?.message || 'Could not inspect the interrupted Job Search.',
        });
      }
    }
    if (processingRunsRef.current.active || !offer) {
      return searchRunOutcome(processingRunsRef.current.active ? 'busy' : 'not-found');
    }
    let liveData = getNode(id)?.data || data;
    const currentResumeLocation = normalizeLocationInput(
      liveData.canonicalLocation || liveData.preferredLocation || '',
    ).boardReady;
    const offerResumeLocation = normalizeLocationInput(offer?.canonicalLocation || '').boardReady;
    const offerLocationMatches = !!offer?.locationRecorded
      && currentResumeLocation === offerResumeLocation;
    // Resume is bound to the manifest's original source breadth, not today’s
    // platform toggles. In particular, a fully gathered recovery can score its
    // staged rows with every current platform disabled.
    if (!offerLocationMatches) {
      updateGlobal(id, {
        errorMessage: offer.locationRecorded
          ? `The unfinished run targeted ${offerResumeLocation || 'no location'}, while this hub now targets ${currentResumeLocation || 'no location'}. Start fresh to keep locations separate.`
          : 'This unfinished run is missing location-safe resume metadata. Start fresh to keep locations separate.',
        rerunOutcome: null,
        rerunNotice: null,
      });
      return searchRunOutcome('not-ready', { error: 'The interrupted run targets a different location.' });
    }
    const currentResumeFingerprint = normalizeResumeProfileFingerprint(liveData.resumeFingerprint);
    const offerResumeFingerprint = normalizeResumeProfileFingerprint(offer?.profileFingerprint);
    if (!currentResumeFingerprint || !offerResumeFingerprint || currentResumeFingerprint !== offerResumeFingerprint) {
      const error = !offerResumeFingerprint
        ? 'This unfinished run is missing profile-safe resume metadata. Start fresh to search with the current career profile.'
        : !currentResumeFingerprint
          ? 'This Job Search no longer has the profile fingerprint that created the unfinished run. Start fresh to continue safely.'
          : 'The career profile changed after this search was staged. Start fresh so saved jobs are not resumed under a different profile.';
      updateGlobal(id, { errorMessage: error, rerunOutcome: null, rerunNotice: null });
      return queueManagedByBoard
        ? searchRunOutcome('recovery-inspection-failed', { runId: offer.runId || null, error })
        : searchRunOutcome('not-ready', { runId: offer.runId || null, error });
    }
    let profile = liveData.resumeProfile;
    const queries = Array.isArray(offer.queries) ? offer.queries : [];
    // Need a profile (persists in node data across restarts) + the run's queries.
    if (!profile || queries.length === 0) {
      if (!queueManagedByBoard) {
        await window.electronAPI?.discardJobRun?.({ canvasFilePath: cfp, nodeId: id, runId: offer.runId || null }).catch(() => {});
        setResumeOffer(current => current?.runId === offer.runId ? null : current);
      }
      return searchRunOutcome('not-ready', { error: 'The interrupted run is missing its career profile or queries.' });
    }
    const admissionToken = Symbol(`resume-job-search:${offer.runId || id}`);
    if (!queueManagedByBoard) {
      if (localQueueAdmissionRef.current) return searchRunOutcome('busy');
      localQueueAdmissionRef.current = admissionToken;
    }
    const currentId = id;
    const locallyCancelled = epoch.start();
    const cancelled = () => locallyCancelled()
      || (typeof parentCancelled === 'function' && parentCancelled());
    const manualAiRunId = options?.manualAiRunId || createManualAiRunId(currentId);
    // Resume semantics come exclusively from the sidecar that owns the staged
    // rows. Falling back to the editable hub values would silently apply a
    // post-crash target role or Job Preferences edit to the interrupted run.
    const activeTargetRole = typeof offer.targetRole === 'string' ? offer.targetRole : '';
    // A crash-resumed run must keep the preference contract it originally
    // started with. Editing the textarea while the offer is visible applies to
    // the next fresh run, not the staged search.
    const activeJobPreferences = typeof offer.jobPreferences === 'string' ? offer.jobPreferences : '';
    let jobPreferencesInterpretation = offer.jobPreferencePlan ?? offer.preferencePlan ?? null;
    let lease = null;
    let processingToken = null;
    let standaloneBecameBoardManaged = false;
    try {
      if (!queueManagedByBoard) {
        lease = await moduleRunQueue.acquireModuleRun({
          nodeId: currentId,
          kind: 'jobsearch',
          lane: 'job-search',
          label: 'Resume job search',
          onQueued: ({ position }) => {
            // Keep the last completed disposition mergeable until this turn
            // actually starts. The queue receipt alone communicates waiting.
            updateGlobal(currentId, {
              queuedModuleRun: { label: 'Resuming job search', position },
            });
          },
          onQueueUpdate: ({ position }) => {
            updateGlobal(currentId, { queuedModuleRun: { label: 'Resuming job search', position } });
          },
          onStart: () => {
            if (cancelled() || isJobWorkflowDeletionPending(currentId)) throw new Error('Node deleted');
            if (
              isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())
              || findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())
            ) {
              standaloneBecameBoardManaged = true;
              return;
            }
            updateGlobal(currentId, { queuedModuleRun: null });
          },
        });
        if (standaloneBecameBoardManaged) {
          updateGlobal(currentId, { queuedModuleRun: null });
          addToast({
            title: 'Resume from Job Board',
            description: 'This interrupted search was kept unchanged. Resume it from its connected Job Board.',
            type: 'info',
          });
          return searchRunOutcome('not-ready', {
            error: 'This interrupted search is now managed by a connected Job Board.',
          });
        }
        if (
          isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())
          || findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())
        ) {
          updateGlobal(currentId, { queuedModuleRun: null });
          return searchRunOutcome('paused', {
            error: 'This interrupted Search was reserved by its Job Board while queued.',
          });
        }
        // The offer can be replaced while this request waits behind another
        // job transaction. Bind the resume to the exact still-current token.
        const currentOffer = await window.electronAPI?.peekJobRun?.({ canvasFilePath: cfp, nodeId: currentId });
        if (cancelled()) return searchRunOutcome('cancelled', { runId: offer.runId || null });
        if (
          isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())
          || findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())
        ) {
          updateGlobal(currentId, { queuedModuleRun: null });
          return searchRunOutcome('paused', {
            runId: offer.runId || null,
            error: 'This interrupted Search was reserved by its Job Board while queued.',
          });
        }
        const recheckedOfferFingerprint = normalizeResumeProfileFingerprint(currentOffer?.profileFingerprint);
        if (!recheckedOfferFingerprint || recheckedOfferFingerprint !== offerResumeFingerprint) {
          updateGlobal(currentId, { queuedModuleRun: null });
          return searchRunOutcome('not-ready', {
            runId: offer.runId || null,
            error: 'The interrupted search profile identity changed while it was queued. Start fresh to continue safely.',
          });
        }
        if (
          !currentOffer?.found
          || !currentOffer?.resumable
          || currentOffer?.nodeId !== currentId
          || currentOffer?.runId !== offer.runId
        ) {
          if (currentOffer?.found && currentOffer?.resumable && currentOffer?.nodeId === currentId) {
            setResumeOffer(currentOffer);
          }
          updateGlobal(currentId, { queuedModuleRun: null });
          return searchRunOutcome('not-ready', { error: 'The interrupted search changed while it was queued.' });
        }
      } else {
        if (!orchestratorNodeId) {
          return searchRunOutcome('failed', { error: 'A Board-managed resume requires an orchestrator node id.' });
        }
        updateGlobal(currentId, { queuedModuleRun: null });
        EventLogger.log(`[JobSearch][${currentId}] Interrupted-run queue delegated to Job Board ${orchestratorNodeId}`);
      }

      liveData = getNode(currentId)?.data || null;
      const laneResumeLocation = normalizeLocationInput(
        liveData?.canonicalLocation || liveData?.preferredLocation || '',
      ).boardReady;
      const laneResumeFingerprint = normalizeResumeProfileFingerprint(liveData?.resumeFingerprint);
      if (
        !liveData
        || liveData.locked
        || isJobWorkflowDeletionPending(currentId)
        || hasPendingManualAiRetirement(liveData)
        || laneResumeLocation !== offerResumeLocation
        || !(liveData.resumeProfile && typeof liveData.resumeProfile === 'object')
      ) {
        return searchRunOutcome('not-ready', {
          runId: offer.runId || null,
          error: 'This interrupted Job Search became unavailable or changed while it was queued.',
        });
      }
      if (!offerResumeFingerprint || !laneResumeFingerprint || laneResumeFingerprint !== offerResumeFingerprint) {
        const error = !offerResumeFingerprint
          ? 'This unfinished run is missing profile-safe resume metadata. Start fresh to search with the current career profile.'
          : !laneResumeFingerprint
            ? 'This Job Search no longer has the profile fingerprint that created the unfinished run. Start fresh to continue safely.'
            : 'The career profile changed while this recovery was queued. Start fresh so saved jobs are not resumed under a different profile.';
        return queueManagedByBoard
          ? searchRunOutcome('recovery-inspection-failed', { runId: offer.runId || null, error })
          : searchRunOutcome('not-ready', { runId: offer.runId || null, error });
      }
      if (platformsVerifyingRef.current) {
        return searchRunOutcome('not-ready', {
          runId: offer.runId || null,
          error: 'Its selected platform connections are still being checked.',
          ...(queueManagedByBoard ? { transientReason: 'platforms-verifying' } : {}),
        });
      }
      profile = liveData.resumeProfile;

      processingToken = processingRunsRef.current.start();
      if (!processingToken) return searchRunOutcome('busy');
      if (cancelled()) return searchRunOutcome('cancelled', { runId: offer.runId || null });
      activeManualAiRunIdRef.current = manualAiRunId;
      // Source progress and cancellation events are generation-scoped. A
      // resumed scrape keeps its original backend run id, so publish that id
      // to the renderer guard before the first resumed source event arrives.
      jobRunIdRef.current = offer.runId || null;
      setResumeOffer(current => current?.runId === offer.runId ? null : current);

      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
      // A malformed/future plan is sanitized to null on manifest read. The raw
      // user preference text is still durable, so recover a plan rather than
      // treating it as empty and accidentally admitting every staged job.
      // ROLE LOCKING: the hub's own durable lock (liveData.searchBriefPlan,
      // gated on hasResolvedRoleLock(liveData) — FIX 2: resolvedRolesMeta, not
      // resolvedRoles.length, so a legitimate zero-title lock still counts)
      // is authoritative AND free — prefer it over a fresh model call. It
      // will match this run's own manifest plan in the normal case (the
      // brief is frozen read-only once locked, so nothing can have diverged),
      // and it is the only option that costs zero interpretation calls,
      // exactly like every other post-lock reuse in this module. Only a hub
      // that somehow never locked (a legacy manifest from before role
      // locking shipped) falls through to re-interpreting the raw text — the
      // sole remaining recovery fallback.
      if (activeJobPreferences && !jobPreferencesInterpretation) {
        if (hasResolvedRoleLock(liveData) && liveData.searchBriefPlan) {
          jobPreferencesInterpretation = liveData.searchBriefPlan;
        } else if (window.electronAPI?.interpretJobPreferences) {
          updateGlobal(currentId, { hubState: 'interpreting-preferences' });
          const interpretationResult = await window.electronAPI.interpretJobPreferences({
            profile,
            careerData: liveData.careerData,
            nodeId: currentId,
            manualAiRunId,
            targetRole: activeTargetRole,
            jobPreferences: activeJobPreferences,
            searchLocation: liveData.locationSnapshot?.searchLocation || null,
            remoteResidences: liveData.locationSnapshot?.remoteResidences || null,
          });
          if (cancelled()) return;
          if (interpretationResult?.success === false) {
            const err = new Error(interpretationResult.error || 'Failed to restore Job Preferences for this resumed search');
            throw err;
          }
          jobPreferencesInterpretation = interpretationResult?.preferencePlan
            ?? interpretationResult?.jobPreferencePlan
            ?? interpretationResult?.jobPreferencesInterpretation
            ?? null;
        }
      }
      updateGlobal(currentId, {
        hubState: 'searching',
        activeTargetRole,
        activeJobPreferences,
        jobPreferencePlan: jobPreferencesInterpretation,
        jobPreferencesInterpretation,
      });
      if (cancelled()) return searchRunOutcome('cancelled', { runId: offer.runId || null });
      // resume:true → search-jobs re-scrapes only the unfinished sources from their
      // last completed page and reuses staged jobs from finished sources.
      const searchResult = await window.electronAPI.searchJobs({
        queries,
        nodeId: currentId,
        maxAgeDays: liveData.maxAgeDays || 21,
        collectionLimits,
        enabledSourceIds,
        canvasFilePath: cfp,
        preferredLocation: liveData.canonicalLocation || liveData.preferredLocation || '',
        rawLocation: liveData.preferredLocation || '',
        profileLocations: profile?.locations || [],
        // There is no post-search title gate to apply anymore — recovery
        // just needs to keep scraping the same manifest-frozen bundle
        // (`queries` above). `targetRole` is still sent from the manifest —
        // the role THIS RUN was gathered under, never the hub's current
        // value, so editing the target role after a crash can't retroactively
        // relabel rows collected under the old one — but it is display/
        // snapshot data only now, not a filter.
        targetRole: offer.targetRole || '',
        jobPreferences: activeJobPreferences,
        preferencePlan: jobPreferencesInterpretation,
        countryScope: liveData.canonicalCountry || '',
        resume: true,
        // The offer is hub-scoped and can become stale if this hub starts
        // another run before this click reaches the main process. Bind recovery
        // to the exact manifest token so staged results never cross runs.
        resumeRunId: offer.runId || null,
        profileFingerprint: laneResumeFingerprint,
        runOrigin: 'crash-resume',
        profileInputMode: 'stored-profile',
      });
      if (cancelled()) return;
      // Same failure handling as runPipeline — resume targets exactly the
      // post-restart scenario where a browser session has expired, so an
      // unhandled failure here must not read as a genuine empty search.
      if (!searchResult?.success && searchResult?.diceApiDown) {
        throw new Error(searchResult.error || 'Dice API is unavailable — search cancelled');
      }
      if (!searchResult?.success && Array.isArray(searchResult?.notLoggedIn) && searchResult.notLoggedIn.length > 0) {
        const names = searchResult.notLoggedIn.map(loginId => JOB_SOURCE_BY_ID[loginId]?.name || loginId);
        throw Object.assign(
          new Error(`Log in to ${names.join(', ')} first (Settings → Job Platform Logins)`),
          { isLoginGate: true, notLoggedIn: searchResult.notLoggedIn }
        );
      }
      // The Board supplied the exact token it just inspected. A vanished or
      // replaced manifest is an inspection failure, never an ordinary failed
      // scrape: JobBoardNode retains its durable receipt and reports Retry
      // instead of retiring the transaction as a provider failure.
      const exactRecoveryFailure = queueManagedByBoard
        ? exactInterruptedRecoveryBackendFailure(searchResult, offer.runId)
        : null;
      if (exactRecoveryFailure) {
        return searchRunOutcome('recovery-inspection-failed', exactRecoveryFailure);
      }
      if (!searchResult?.success) {
        throw new Error(searchResult?.error || 'Job search failed');
      }
      const foundJobs = Array.isArray(searchResult.jobs) ? searchResult.jobs : [];
      // A crash-resume receives the same response shape as a fresh search.
      // Prefer its source-card-aligned collection total; `rawCount` is only
      // retained as the fallback for main processes from before `gatheredCount`.
      const visibleGatheredCount = searchResult.gatheredCount ?? searchResult.rawCount ?? foundJobs.length;
      const warnings = Array.isArray(searchResult?.scrapeWarnings) ? searchResult.scrapeWarnings : [];
      const blockingWarnings = warnings.filter(isJobSourceWarningGating);
      // Same post-search disposition as runPipeline (block-gate pause / empty terminal).
      // Computed once from the live node snapshot captured at admission.
      const locationSnapshot = liveData.locationSnapshot || {
        searchLocation: getSearchLocation({
          searchLocation: liveData.searchLocation,
          preferredLocation: liveData.preferredLocation,
          canonicalLocation: liveData.canonicalLocation,
        }),
        remoteResidences: normalizeRemoteResidences(liveData.remoteResidences),
      };
      const postSearchResult = await handlePostSearchResult({
        currentId, foundJobs, warnings, blockingWarnings,
        profile, activeTargetRole, activeJobPreferences, jobPreferencesInterpretation, canvasFilePath: cfp,
        jobRunId: searchResult?.runId || null,
        descriptionRecoveryJobs: Array.isArray(searchResult?.descriptionRecoveryJobs)
          ? searchResult.descriptionRecoveryJobs
          : null,
        collectionScopeCaveats: searchResult?.collectionScopeCaveats,
        gatheredCount: visibleGatheredCount,
        locationSnapshot,
        cancelled,
      });
      if (!postSearchResult.shouldScore) {
        await completeManualAiRun(manualAiRunId);
        if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult?.runId || null });
        return postSearchResult.outcome || searchRunOutcome('failed', {
          runId: searchResult?.runId || null,
          error: 'The resumed search stopped without a terminal result.',
        });
      }
      const finalWarnings = postSearchResult.warnings;
      const finalCollectionScopeCaveats = normalizeCollectionScopeCaveats(searchResult?.collectionScopeCaveats);
      const preferenceResult = await evaluatePreferencesForRun({
        jobs: foundJobs,
        profile,
        careerData: liveData.careerData,
        activeTargetRole,
        activeJobPreferences,
        jobPreferencesInterpretation,
        locationSnapshot,
        manualAiRunId,
      });
      if (cancelled()) return;
      if (preferenceResult.jobs.length === 0) {
        const completion = searchResult?.runId
          ? await completeJobRun(searchResult.runId, 'completed', 'preference-filtered', cfp, 0, moduleFingerprint([]), cancelled)
          : null;
        if (cancelled()) return;
        updateGlobal(currentId, {
          hubState: 'done', scoredJobs: [], finalSourceCounts: {}, resultCount: 0, totalScoredCount: 0,
          scrapedCount: 0, gatheredCount: visibleGatheredCount,
          preferenceMatchedCount: preferenceResult.matchedCount,
          preferenceFilteredCount: preferenceResult.filteredCount,
          preferenceEvaluation: preferenceResult.evaluation,
          preferenceCandidatePool: preferenceResult.candidatePool,
          pendingJobs: null, scrapeWarnings: finalWarnings,
          collectionScopeCaveats: normalizeCollectionScopeCaveats(finalCollectionScopeCaveats),
          resultDisposition: 'preference-filtered',
          errorMessage: terminalFinalizationError(searchResult?.runId, cfp, completion),
        });
        await completeManualAiRun(manualAiRunId);
        if (cancelled()) return searchRunOutcome('cancelled', { runId: searchResult?.runId || null });
        const completionError = terminalFinalizationError(searchResult?.runId, cfp, completion);
        return completionError
          ? searchRunOutcome('recovery-finalization-failed', {
            runId: searchResult?.runId || null,
            resultDisposition: 'preference-filtered',
            error: completionError,
          })
          : searchRunOutcome('completed', {
            runId: searchResult?.runId || null,
            resultDisposition: 'preference-filtered',
          });
      }
      return await runScoringAndSpawn({
        profile, jobs: preferenceResult.jobs,
        gatheredCount: visibleGatheredCount,
        scrapeWarnings: finalWarnings, collectionScopeCaveats: finalCollectionScopeCaveats, activeTargetRole, originalPos,
        activeJobPreferences, jobPreferencesInterpretation,
        preferenceMatchedCount: preferenceResult.matchedCount,
        preferenceFilteredCount: preferenceResult.filteredCount,
        preferenceEvaluation: preferenceResult.evaluation,
        preferenceCandidatePool: preferenceResult.candidatePool,
        jobRunId: searchResult?.runId || null, cancelled,
        locationSnapshot,
        manualAiRunId,
      });
    } catch (error) {
      if (queueManagedByBoard && isJobBoardUserCancellation(error)) {
        const control = boardRunControlRef.current;
        if (
          control
          && control.orchestratorNodeId === orchestratorNodeId
          && typeof cancelBoardRunRef.current === 'function'
        ) {
          let result;
          if (control.rollbackApplied) {
            await control.rollbackPromise;
            result = { runId: control.cancelledRunId || null };
          } else {
            result = await cancelBoardRunRef.current({
              orchestratorNodeId,
              boardRunId: control.boardRunId,
              reason: 'manual-ai-cancelled',
            });
          }
          return searchRunOutcome('cancelled', { runId: result?.runId || offer.runId || null });
        }
      }
      if (cancelled() || isNodeDeletedAbort(error)) {
        return searchRunOutcome('cancelled', { runId: offer.runId || null });
      }
      EventLogger.error('[JobSearch] Resume run failed:', error);
      // Same policy as runPipeline's catch: a resume attempted from 'done' with
      // prior scored jobs still on the hub must not wipe the board back to empty.
      const hubHasResults = (getNode(currentId)?.data?.scoredJobs?.length || 0) > 0;
      updateGlobal(currentId, {
        hubState: hubHasResults ? 'done' : 'empty',
        resultDisposition: hubHasResults ? 'incomplete' : null,
        errorMessage: error?.message || String(error),
        rerunOutcome: null,
        rerunNotice: null,
      });
      return searchRunOutcome('failed', {
        runId: offer.runId || null,
        resultDisposition: hubHasResults ? 'incomplete' : null,
        error: error?.message || String(error),
      });
    } finally {
      if (!queueManagedByBoard && getNode(currentId)) {
        updateGlobal(currentId, (node) => (
          node?.data?.queuedModuleRun?.label === 'Resuming job search'
            ? { queuedModuleRun: null }
            : null
        ));
      }
      if (activeManualAiRunIdRef.current === manualAiRunId) activeManualAiRunIdRef.current = null;
      if (processingToken && isMountedRef.current) processingRunsRef.current.finish(processingToken);
      if (!queueManagedByBoard && localQueueAdmissionRef.current === admissionToken) {
        localQueueAdmissionRef.current = null;
      }
      if (lease) await waitForRendererCommitFrame();
      lease?.release();
    }
  }, [addToast, canvasFilePath, resumeOffer, id, data, collectionLimits, enabledSourceIds, epoch, getEdges, getNode, getNodes, updateGlobal, runScoringAndSpawn, handlePostSearchResult, moduleRunQueue, isMountedRef, completeJobRun, completeManualAiRun, evaluatePreferencesForRun, deferDirectSearchToBoard]);

  resumeInterruptedRunRef.current = handleResumeRun;

  const handleDiscardResume = useCallback(async () => {
    if (
      getNode(id)?.data?.terminalFinalizationRecovery
      || findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())
    ) {
      addToast({
        title: 'Recovery is reserved',
        description: 'Finish or cancel the owning search transaction before starting fresh.',
        type: 'info',
      });
      return;
    }
    // Defense in depth for a stale async offer: only its owning hub may clear
    // the token-scoped sidecar. A node-less legacy offer uses an intentionally
    // separate IPC that proves the manifest is STILL owner-unknown under lock.
    const legacyUnknownOwner = !resumeOffer?.nodeId;
    if (!legacyUnknownOwner && resumeOffer?.nodeId !== id) return;
    const runId = resumeOffer?.runId || null;
    try {
      let cleanup;
      if (legacyUnknownOwner) {
        cleanup = await window.electronAPI?.discardUnknownOwnerJobRun?.({ canvasFilePath, runId });
      } else {
        cleanup = await window.electronAPI?.discardJobRun?.({ canvasFilePath, nodeId: id, runId });
      }
      if (cleanup?.ok === true && (cleanup.cleared === true || cleanup.absent === true)) {
        setResumeOffer(current => current?.runId === runId ? null : current);
        // A connected Job Board may have cached this exact sidecar as a
        // resumable disabled-platform recovery. Clearing the token lives only
        // on disk, so notify that Board to drop its scoped cache immediately
        // instead of leaving a stale Resume affordance until another click.
        document.dispatchEvent(new CustomEvent('job-run-recovery-ledger-changed', {
          detail: { hubId: id, canvasFilePath, runId },
        }));
        return;
      }
      throw new Error(cleanup?.tokenMismatch
        ? 'A newer Job Search recovery replaced this offer. Reopen the module to review it.'
        : 'The unfinished Job Search recovery files could not be cleared safely.');
    } catch (error) {
      EventLogger.error(`[JobSearch][${id}] Start fresh could not retire recovery run=${runId}:`, error);
      addToast({
        title: 'Could not start fresh',
        description: error?.message || 'The saved recovery was kept. Try again.',
        type: 'error',
      });
    }
  }, [addToast, canvasFilePath, resumeOffer, id, getNode, getNodes, getEdges]);

  // Listen for individual job-source skips dispatched from JobSourceCardNode.
  // Each event drops the matching warning from data.scrapeWarnings; once the
  // remaining list is empty AND we're in the paused 'sources-ready' state,
  // auto-resume scoring with whatever the partial search collected.
  useEffect(() => {
    const onSkip = (e) => {
      if (e.detail?.hubId !== id) return;
      if (isJobWorkflowDeletionPending(id)) return;
      const skippedSourceId = e.detail?.sourceId;
      if (!skippedSourceId) return;
      // A retained source card can outlive its warning generation. Do not let
      // an old Skip clear the current paused run or trigger its scoring lane;
      // source cards now always carry their captured generation in this event.
      const skippedJobRunId = e.detail?.jobRunId || null;
      const activeJobRunId = jobRunIdRef.current || null;
      const activeBoardOwner = findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges());
      if (
        skippedJobRunId !== activeJobRunId
        // Pre-token legacy standalone cards can still skip their matching
        // pre-token hub. A Board pause, however, is always tokenized and must
        // fail closed if its source card did not carry that exact token.
        || (activeBoardOwner && !skippedJobRunId)
        || isJobSearchBoardPausedContinuationBlocked(id, skippedJobRunId, getNodes(), getEdges())
      ) {
        EventLogger.log(`[JobSearch][${id}] Ignored stale source skip for ${skippedSourceId}`);
        return;
      }
      const warningAction = e.detail?.action === 'dismiss' ? 'dismiss' : 'skip';
      if (hubStateRef.current === 'searching') {
        // A decision made while the other sources are still running must survive
        // the backend's stale final warning list. Otherwise an early Skip can
        // reappear at search completion and pause the pipeline a second time.
        sourceWarningOverridesDuringSearchRef.current.set(skippedSourceId, null);
      }
      const remaining = (scrapeWarningsRef.current || []).filter(w => w.sourceId !== skippedSourceId);
      scrapeWarningsRef.current = remaining;
      updateGlobal(id, { scrapeWarnings: remaining });
      EventLogger.log(
        `[JobSearch][${id}] User ${warningAction === 'dismiss' ? 'dismissed non-blocking warning' : 'skipped blocked source'} ${skippedSourceId}`
        + ` code=${e.detail?.warningCode || 'unknown'} severity=${e.detail?.warningSeverity || 'unknown'}`
        + ` hubState=${hubStateRef.current || 'unknown'} pendingJobs=${Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current.length : 0}`,
      );
      // Resume once no GATING warning remains (captcha/login walls + the LinkedIn
      // rate-limit; see isJobSourceWarningGating). info-severity warnings (e.g. USAJobs
      // config-missing, shown so the user knows why that source returned 0 but
      // not requiring action) and non-LinkedIn throttles should NOT keep the
      // resume from firing — the user already addressed every actionable block.
      const remainingBlocks = remaining.filter(isJobSourceWarningGating);
      if (
        remainingBlocks.length === 0 &&
        hubStateRef.current === 'sources-ready' &&
        !processingRunsRef.current.active
      ) {
        scheduleCleanSourceCardDismiss('all-blocks-skipped');
        // resumeScoring scores pendingJobs, or finishes in empty 'done' when
        // none were collected — so skipping the last blocked source never
        // leaves the hub stuck on the paused screen.
        const continuation = resumeScoringRef.current?.({
          queueManagedExternally: Array.isArray(e.detail?.continuationPromises),
        });
        if (continuation && Array.isArray(e.detail?.continuationPromises)) {
          e.detail.continuationPromises.push(Promise.resolve(continuation));
        }
      }
    };
    document.addEventListener('job-source-skip', onSkip);
    return () => document.removeEventListener('job-source-skip', onSkip);
  }, [getEdges, getNodes, id, updateGlobal, scheduleCleanSourceCardDismiss]);

  // A browser Solve that could not open/navigate (or returned unresolved)
  // still needs to put back the warning optimistically removed by
  // `job-source-retry-start`. That is warning-only state: no rows were
  // recovered, so it must not pass through the successful resolve listener
  // below, which merges pending jobs and emits a "Resolved … N items" receipt.
  useEffect(() => {
    const onResolveFailed = (e) => {
      if (e.detail?.hubId !== id) return;
      // A Solve may have optimistically hidden this exact warning immediately
      // before a reversible deletion began. Permit only that idempotent
      // restoration during the pending window; ordinary late events remain
      // fenced until deletion either commits or aborts.
      if (isJobWorkflowDeletionPending(id) && e.detail?.restorative !== true) return;
      if ((e.detail?.jobRunId || null) !== (jobRunIdRef.current || null)) {
        EventLogger.log(`[JobSearch][${id}] Ignored stale failed source resolve for ${e.detail?.sourceId || 'unknown source'}`);
        return;
      }
      const sourceId = e.detail?.sourceId;
      const warning = e.detail?.warning || null;
      if (!sourceId || !warning) return;

      const current = scrapeWarningsRef.current || [];
      const restored = { sourceId, ...warning };
      const remaining = current.filter(item => item.sourceId !== sourceId);
      // `job-source-retry-start` deliberately KEEPS this source's gating
      // warnings and trims only its non-gating siblings — one source can end a
      // run holding several entries (reconcileJobSourceWarnings keeps a
      // per-source override alongside the run's own entry, and jobs.js appends
      // LinkedIn's enrichment warnings after the per-source list). Collapsing
      // every entry for the source into the single restored warning threw that
      // preserved gate away moments after the click kept it, which un-paused
      // the hub and let a later Skip auto-resume a run that was still blocked —
      // the exact hazard the partition exists to prevent. Re-add the source's
      // other gates, minus the one the restored warning already is.
      remaining.push(
        ...current.filter(item => item?.sourceId === sourceId
          && isJobSourceWarningGating(item)
          && !isSameJobSourceWarningEntry(item, restored)
          // See the matching note on the resolved path: a Solve supersedes this
          // source's earlier description-domain gate.
          && !(isDescriptionRecoveryWarningCode(item) && isDescriptionRecoveryWarningCode(restored))),
        restored,
      );
      scrapeWarningsRef.current = remaining;
      updateGlobal(id, { scrapeWarnings: remaining });
      EventLogger.log(`[JobSearch][${id}] Solve for ${sourceId} did not complete; restored its actionable warning`);
    };
    document.addEventListener('job-source-resolve-failed', onResolveFailed);
    return () => document.removeEventListener('job-source-resolve-failed', onResolveFailed);
  }, [id, updateGlobal]);

  // Listen for job-source-resolved dispatched after a captcha/continue attempt.
  // Carries `items` on successful recoveries plus the active warning on failed
  // attempts, so the hub can keep its collected-listing count and warning state
  // aligned. Replacement solves do not change that collection count: they only
  // improve or replace rows that the initial source search already gathered.
  // Merge jobs into pendingJobs by (title|company|url) fingerprint so a
  // retry-of-a-retry doesn't double-count, drop the source's warning, and
  // auto-resume scoring once the last blocking warning is cleared.
  useEffect(() => {
    const onResolved = (e) => {
      if (e.detail?.hubId !== id) return;
      if (isJobWorkflowDeletionPending(id)) return;
      // A Solve can outlive its originating paused run. Re-run clears the
      // renderer token synchronously, and a fresh search installs a new token;
      // either way, a late result from the old run is ignored.
      if ((e.detail?.jobRunId || null) !== (jobRunIdRef.current || null)) {
        EventLogger.log(`[JobSearch][${id}] Ignored stale source resolve for ${e.detail?.sourceId || 'unknown source'}`);
        return;
      }
      // The source resolver holds the global lane and can return after its
      // Board records cancellation intent. The result may still carry the
      // current Search token, so independently require the exact paused Board
      // handoff before changing pending jobs, warnings, or starting externally
      // managed scoring.
      if (isJobSearchBoardPausedContinuationBlocked(id, e.detail?.jobRunId || null, getNodes(), getEdges())) {
        EventLogger.log(`[JobSearch][${id}] Ignored source resolve after its Board continuation was fenced for ${e.detail?.sourceId || 'unknown source'}`);
        return;
      }
      const resolvedSourceId = e.detail?.sourceId;
      if (!resolvedSourceId) return;
      // The successful-resolve channel is merge-authoritative. Refuse a
      // malformed/legacy event unless it explicitly confirms recovery, so a
      // failed launch can never be reinterpreted as a zero-item success by the
      // hub even if another caller accidentally uses this event name.
      if (e.detail?.resolved !== true) return;
      // Apply only an explicit collection delta. Do not infer it from the
      // source card's transient display count: during description recovery that
      // count can mean the remaining/enriched subset rather than listings the
      // provider returned, which would corrupt the source-gathered total.
      const gatheredCountDelta = Number(e.detail?.gatheredCountDelta);
      if (Number.isFinite(gatheredCountDelta)) {
        gatheredCountRef.current = Math.max(0, (Number(gatheredCountRef.current) || 0) + gatheredCountDelta);
      }
      const items = Array.isArray(e.detail?.items) ? e.detail.items : [];
      // Only a confirmed resolve overrides the backend's final warning. A
      // failed `resolved:false` event may restore the card locally, but it must
      // never hide the still-authoritative warning returned by the live search.
      if (hubStateRef.current === 'searching' && e.detail?.resolved === true) {
        sourceWarningOverridesDuringSearchRef.current.set(resolvedSourceId, e.detail?.warning || null);
      }
      // Merge new items into pendingJobs. LinkedIn re-fetch returns the full
      // source set and requests replacement; captcha/Continue flows return
      // incremental pages and keep already-captured same-source jobs.
      const prevPending = Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current : [];
      const replaceSourceItems = !!e.detail?.replaceSourceItems;
      const replaceMatchingItems = !!e.detail?.replaceMatchingItems;
      const removedItemKeys = Array.isArray(e.detail?.removedItemKeys) ? e.detail.removedItemKeys : [];
      const { fresh, mergedPending, replacedExisting } = mergeResolvedSourceItems(
        prevPending,
        items,
        resolvedSourceId,
        { replaceSourceItems, replaceMatchingItems, removedItemKeys },
      );
      pendingJobsRef.current = mergedPending;
      // Drop the resolved source's warning — then re-add it if the resolve came
      // back STILL warned (LinkedIn re-enrich hit the per-IP guest ceiling again,
      // or the VPN switch hadn't taken so it's the same warm IP). This keeps the
      // done-state ScrapeWarningsPanel mirroring the card's actionable state
      // instead of clearing on every attempt regardless of outcome. Captcha /
      // resume resolves carry no warning, so they clear cleanly as before.
      const resolveWarning = e.detail?.warning || null;
      const currentWarnings = scrapeWarningsRef.current || [];
      const remaining = currentWarnings.filter(w => w.sourceId !== resolvedSourceId);
      if (resolveWarning) {
        const restored = { sourceId: resolvedSourceId, ...resolveWarning };
        // Same partition as `job-source-retry-start`, which kept this source's
        // OTHER gating warnings while the Solve ran: re-adding only the
        // returned warning would discard a gate the click deliberately
        // preserved and let a later Skip auto-resume a still-blocked run. A
        // resolve that comes back with NO warning is untouched by this — it
        // still clears the source outright, which is the clean success this
        // whole flow exists to reach.
        remaining.push(
          ...currentWarnings.filter(w => w?.sourceId === resolvedSourceId
            && isJobSourceWarningGating(w)
            && !isSameJobSourceWarningEntry(w, restored)
            // A Solve re-runs this source's DESCRIPTION recovery end to end, so
            // an earlier description-phase gate for the same source describes a
            // pass that no longer exists. Without this, google/glassdoor keep
            // the search-phase `description-rate-limited` gate forever alongside
            // the `description-listing-unavailable` every Solve returns, and the
            // source accumulates one permanently-unclearable entry per Solve.
            // Gates from other domains (a hard block, linkedin-rate-limited)
            // are untouched and still pause the run.
            && !(isDescriptionRecoveryWarningCode(w) && isDescriptionRecoveryWarningCode(restored))),
          restored,
        );
      }
      scrapeWarningsRef.current = remaining;
      updateGlobal(id, {
        pendingJobs: mergedPending,
        jobCount: mergedPending.length,
        gatheredCount: gatheredCountRef.current,
        scrapeWarnings: remaining,
      });
      // Auto-resume on no remaining GATING warnings (info / non-LinkedIn throttle stays).
      const remainingBlocks = remaining.filter(isJobSourceWarningGating);
      // Report the actual merge outcome back to the main process so the bug
      // report can show "net pendingJobs change" rather than just the IPC-side
      // "kept" count. The IPC side doesn't know the renderer dropped same-source
      // existing jobs first (replace-and-dedup), so without this the report says
      // "new: 11" when the actual net change may be 0 (11 replaced 11).
      window.electronAPI.recordResolveMerge?.({
        sourceId: resolvedSourceId,
        // The merge event is emitted after an async browser Solve. Keep it on
        // the exact source-card generation so a late result cannot decorate a
        // newer hub/run's diagnostics.
        nodeId: id,
        jobRunId: e.detail?.jobRunId || jobRunIdRef.current || null,
        replacedExisting,
        fresh: fresh.length,
        pendingBefore: prevPending.length,
        pendingAfter: mergedPending.length,
      });
      const pendingNet = mergedPending.length - prevPending.length;
      EventLogger.log(
        `[JobSearch][${id}] Resolved ${resolvedSourceId}: received ${items.length} item(s); `
        + `replaced ${replacedExisting}, accepted ${fresh.length} after dedup; `
        + `net pendingJobs ${pendingNet >= 0 ? '+' : ''}${pendingNet} (${prevPending.length}→${mergedPending.length}); `
        + `${remainingBlocks.length} block warning(s) remain`,
      );
      if (
        remainingBlocks.length === 0 &&
        hubStateRef.current === 'sources-ready' &&
        !processingRunsRef.current.active
      ) {
        scheduleCleanSourceCardDismiss('all-blocks-resolved');
        // resumeScoring scores the merged jobs, or finishes in empty 'done' if
        // the resolve cleared the last block but yielded nothing to score.
        const continuation = resumeScoringRef.current?.({
          queueManagedExternally: Array.isArray(e.detail?.continuationPromises),
        });
        if (continuation && Array.isArray(e.detail?.continuationPromises)) {
          e.detail.continuationPromises.push(Promise.resolve(continuation));
        }
      }
    };
    document.addEventListener('job-source-resolved', onResolved);
    return () => document.removeEventListener('job-source-resolved', onResolved);
  }, [getEdges, getNodes, id, updateGlobal, scheduleCleanSourceCardDismiss]);

  // Optimistic counterpart to onResolved: JobSourceCardNode dispatches this the
  // instant the user clicks Solve (before the resolve runs). Drop the matching
  // non-blocking warning so the done-state "N throttled" panel reflects the
  // in-flight retry immediately instead of sitting stale through a multi-minute
  // re-fetch — onResolved re-adds it if the attempt comes back still-warned.
  // Gating warnings (block/paste AND the LinkedIn rate-limit) are intentionally
  // left untouched: they gate the paused 'sources-ready' state, and dropping one
  // here could mis-fire auto-resume before the block is actually cleared.
  useEffect(() => {
    const onRetryStart = (e) => {
      if (e.detail?.hubId !== id) return;
      if (isJobWorkflowDeletionPending(id)) return;
      // Current source cards carry the exact generation they proved at click
      // time. A late optimistic retry receipt must not trim a warning from a
      // newer Search after Reset/re-run. Untagged legacy events retain their
      // historic standalone compatibility; successful/Skip events have their
      // own strict generation fences below.
      const retryJobRunId = e.detail?.jobRunId;
      if (
        typeof retryJobRunId === 'string'
        && retryJobRunId
        && retryJobRunId !== (jobRunIdRef.current || null)
      ) return;
      const sid = e.detail?.sourceId;
      if (!sid) return;
      const current = scrapeWarningsRef.current || [];
      // One source can end a run holding MORE THAN ONE final warning:
      // reconcileJobSourceWarnings keeps a per-source override alongside the
      // run's own entry, and jobs.js appends LinkedIn's enrichment warnings
      // after the per-source list. The guard used to inspect only the FIRST
      // match while the removal deleted every entry for the source, so a gate
      // sitting second was trimmed silently — that un-paused the hub and let a
      // later Skip auto-resume a run that was still blocked. Guard and removal
      // now agree on the same set: if ANY entry gates, only the non-gating
      // siblings are stale enough to trim; with no gate at all they all go.
      const entries = current.filter(x => x?.sourceId === sid);
      if (!entries.length) return;
      const remaining = entries.some(isJobSourceWarningGating)
        ? current.filter(x => x?.sourceId !== sid || isJobSourceWarningGating(x))
        : current.filter(x => x?.sourceId !== sid);
      // An all-gating source has nothing to trim; skip the write so the
      // optimistic path cannot churn hub data (and re-render) for no change.
      if (remaining.length === current.length) return;
      scrapeWarningsRef.current = remaining;
      updateGlobal(id, { scrapeWarnings: remaining });
    };
    document.addEventListener('job-source-retry-start', onRetryStart);
    return () => document.removeEventListener('job-source-retry-start', onRetryStart);
  }, [id, updateGlobal]);

  // "Score current results" button on the paused-state UI: clear all
  // remaining warnings (user chose to proceed without resolving) and resume.
  const handleScoreCurrentResults = useCallback(() => {
    if (isJobWorkflowDeletionPending(id)) return;
    const liveData = getNode(id)?.data || data;
    if (liveData.hubState !== 'sources-ready') return;
    // A Source Solve can synchronously admit the exact same continuation before
    // React replaces the paused card. A stale click must not clear warnings or
    // dismiss source cards while that continuation is already evaluating/scoring.
    if (processingRunsRef.current.active || scoringContinuationAdmissionRef.current) return;
    if (hasPendingManualAiRetirement(liveData)) return;
    const liveNodes = getNodes();
    const liveEdges = getEdges();
    const liveBoardRecoveryOwner = findJobSearchBoardActiveRecoveryOwner(
      id,
      liveNodes,
      liveEdges,
    );
    const livePausedBoardContinuationOwner = findJobSearchBoardPausedContinuationOwner(
      id,
      liveData.jobRunId || null,
      liveNodes,
      liveEdges,
    );
    // The card can outlive its selector snapshot while a Board changes phase
    // or the Search advances to a newer run. Re-prove the exact continuation
    // immediately before clearing warnings so that stale clicks fail closed.
    if (liveBoardRecoveryOwner && !livePausedBoardContinuationOwner) {
      addToast({
        title: 'Job Board Run in Progress',
        description: 'Finish or cancel the owning Job Board run before scoring this paused Search.',
        type: 'info',
      });
      return;
    }
    scrapeWarningsRef.current = [];
    updateGlobal(id, { scrapeWarnings: [] });
    // Each source card holds its OWN copy of its warning, so clearing the hub
    // list alone leaves the blocked cards on canvas with live Solve buttons —
    // and rows recovered after scoring has finished are never scored. Tell them
    // to settle the same way their Skip button does so the clean-card dismiss
    // below can actually remove them.
    document.dispatchEvent(new CustomEvent('job-source-clear-warnings', {
      detail: { hubId: id },
    }));
    scheduleCleanSourceCardDismiss('score-current-results');
    resumeScoring();
  }, [addToast, id, data, getEdges, getNode, getNodes, updateGlobal, resumeScoring, scheduleCleanSourceCardDismiss]);

  // Keep the ref up-to-date so handleDrop always calls the latest version.
  useEffect(() => {
    startProcessingRef.current = startProcessing;
  }, [startProcessing]);

  // ── "Solve all blocked sources" ────────────────────────────────────────────
  // One press works through every blocked source in order, and (via the card's
  // own walk) every blocked search query within each source. The user stands by
  // and clears each challenge as its browser window opens.
  //
  // The driver deliberately owns NO moduleRunQueue lease: each card takes the
  // shared 'job-search' lane for its own Solve, and a lane has exactly one
  // active holder — a lease held across these awaits would deadlock on the
  // first card. It also reimplements none of the card's guards; it just asks
  // each card to press its own Solve and waits for the card to report back.
  const solveAllAbortRef = useRef(false);
  const solveAllRunningRef = useRef(false);
  const solveAllActiveSourceRef = useRef(null);
  const [solveAllProgress, setSolveAllProgress] = useState(null);

  const handleStopSolveAll = useCallback(() => {
    if (!solveAllRunningRef.current) return;
    solveAllAbortRef.current = true;
    setSolveAllProgress(prev => (prev ? { ...prev, stopping: true } : prev));
    // The abort flag alone only stops the driver BETWEEN sources — it is never
    // read while the driver is parked awaiting the source in flight, and that
    // source may still have many blocked queries to walk. Tell the running card
    // to end its own walk after the pass already open. Deliberately not a task
    // cancel: cancelNodeTask(hubId) aborts every task registered under the hub,
    // and cancelQueuedRunsForNode's default reason is the load-bearing
    // 'Node deleted' sentinel that trashes a run's recovery sidecars.
    document.dispatchEvent(new CustomEvent('job-source-solve-stop', {
      detail: { hubId: id, sourceId: solveAllActiveSourceRef.current || null },
    }));
    EventLogger.log(`[JobSearch][${id}] User stopped Solve all${solveAllActiveSourceRef.current ? ` during ${solveAllActiveSourceRef.current}` : ''}`);
  }, [id]);

  const handleSolveAllBlockedSources = useCallback(async () => {
    if (solveAllRunningRef.current) return;
    if (isJobWorkflowDeletionPending(id)) return;
    const liveData = getNode(id)?.data || data;
    if (liveData.hubState !== 'sources-ready') return;
    if (processingRunsRef.current.active || scoringContinuationAdmissionRef.current) return;
    if (hasPendingManualAiRetirement(liveData)) return;
    const liveNodes = getNodes();
    const liveEdges = getEdges();
    const liveBoardRecoveryOwner = findJobSearchBoardActiveRecoveryOwner(id, liveNodes, liveEdges);
    const livePausedBoardContinuationOwner = findJobSearchBoardPausedContinuationOwner(
      id,
      liveData.jobRunId || null,
      liveNodes,
      liveEdges,
    );
    // Same re-proof as "Score current results": a stale click must fail closed.
    if (liveBoardRecoveryOwner && !livePausedBoardContinuationOwner) {
      addToast({
        title: 'Job Board Run in Progress',
        description: 'Finish or cancel the owning Job Board run before solving this paused Search.',
        type: 'info',
      });
      return;
    }

    // Guarantee every blocked source actually has a card to drive.
    ensureBlockedSourceCards(scrapeWarningsRef.current);

    // Ordered by the hub's own runnable source order, de-duplicated by source.
    const blockedSourceIds = [];
    const seen = new Set();
    for (const sourceId of activeEnabledSourceIds) {
      const warning = (scrapeWarningsRef.current || []).find(w => (
        w?.sourceId === sourceId && isJobSourceWarningGating(w) && canAttemptJobSourceResolve(w)
      ));
      if (warning && !seen.has(sourceId)) {
        seen.add(sourceId);
        blockedSourceIds.push(sourceId);
      }
    }
    if (blockedSourceIds.length === 0) {
      addToast({
        title: 'Nothing to Solve',
        description: 'No blocked source has a recoverable action. Skip the remaining warnings or score what was gathered.',
        type: 'info',
      });
      return;
    }

    solveAllRunningRef.current = true;
    solveAllAbortRef.current = false;
    setSolveAllProgress({ index: 0, total: blockedSourceIds.length, sourceId: blockedSourceIds[0], stopping: false });
    EventLogger.log(`[JobSearch][${id}] Solve all started for ${blockedSourceIds.length} blocked source(s): ${blockedSourceIds.join(', ')}`);

    // One request → one terminal reply, correlated by request id. The ack is
    // dispatched synchronously by the card during the request, so an unanswered
    // request proves no listener existed rather than leaving the walk hanging.
    const requestSolve = (sourceId) => new Promise((resolve) => {
      const requestId = globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      let acked = false;
      let settled = false;
      const settle = (outcome, detail = {}) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('job-source-solve-ack', onAck);
        document.removeEventListener('job-source-solve-done', onDone);
        resolve({ outcome, detail });
      };
      const onAck = (event) => {
        const d = event.detail || {};
        if (d.hubId !== id || d.requestId !== requestId) return;
        acked = true;
      };
      const onDone = (event) => {
        const d = event.detail || {};
        if (d.hubId !== id || d.requestId !== requestId) return;
        settle(d.outcome || 'failed', d);
      };
      document.addEventListener('job-source-solve-ack', onAck);
      document.addEventListener('job-source-solve-done', onDone);
      document.dispatchEvent(new CustomEvent('job-source-solve-request', {
        detail: { hubId: id, sourceId, requestId },
      }));
      if (!acked) settle('not-delivered');
    });

    const outcomes = [];
    try {
      for (let index = 0; index < blockedSourceIds.length; index += 1) {
        if (solveAllAbortRef.current) break;
        const sourceId = blockedSourceIds[index];
        solveAllActiveSourceRef.current = sourceId;
        setSolveAllProgress({ index, total: blockedSourceIds.length, sourceId, stopping: false });
        if (isJobWorkflowDeletionPending(id)) break;
        if ((getNode(id)?.data?.hubState || null) !== 'sources-ready') break;

        let { outcome, detail } = await requestSolve(sourceId);
        // A card spawned by ensureBlockedSourceCards above is in the node store
        // before its listener effect has run. Give React one turn, then retry
        // this source once.
        if (outcome === 'not-delivered') {
          await new Promise(r => setTimeout(r, 0));
          ({ outcome, detail } = await requestSolve(sourceId));
        }
        // The hub can go busy between sources (a resolve's own scoring
        // continuation). Wait for it to settle rather than skipping a source
        // that is genuinely still blocked.
        let busyRetries = 0;
        while (outcome === 'busy' && busyRetries < 20 && !solveAllAbortRef.current) {
          busyRetries += 1;
          await new Promise(r => setTimeout(r, 500));
          ({ outcome, detail } = await requestSolve(sourceId));
        }
        outcomes.push({ sourceId, outcome });
        // Log why a source ended still-blocked: queries left, whether the
        // backend said stop, and whether the user stopped this one by hand.
        const stillBlockedDetail = outcome === 'still-blocked'
          ? ` (${Number.isFinite(detail?.remainingBlockedCount) ? `${detail.remainingBlockedCount} quer${detail.remainingBlockedCount === 1 ? 'y' : 'ies'} left` : 'no query count reported'}`
            + `${detail?.recoveryGuidance?.recommendation ? `, backend recommends ${detail.recoveryGuidance.recommendation}` : ''}`
            + `${detail?.stoppedByUser ? ', stopped by user' : ''})`
          : '';
        EventLogger.log(`[JobSearch][${id}] Solve all: ${sourceId} → ${outcome}${stillBlockedDetail}`);
        // Ownership changed under us: stop rather than stacking one toast per
        // remaining source.
        if (outcome === 'board-owned' || outcome === 'stale-run' || outcome === 'hub-locked') break;
        if (outcome === 'cancelled') break;
        // NOT a sequence-level stop: `stoppedByUser` is also set when the user
        // stops just THIS source from its own card ("remaining queries stay
        // available"), and aborting the other blocked sources on that is wrong.
        // The hub's own Stop button sets solveAllAbortRef, which the loop head
        // checks — that is the sequence-level abort.
      }
    } finally {
      solveAllRunningRef.current = false;
      solveAllAbortRef.current = false;
      solveAllActiveSourceRef.current = null;
      setSolveAllProgress(null);
      // Never end silently on a partial result: a source that stayed busy, or
      // was never reached because the sequence stopped, still needs attention
      // and the user has no other way to learn which one.
      const resolvedCount = outcomes.filter(o => o.outcome === 'resolved').length;
      const unresolved = outcomes.filter(o => o.outcome !== 'resolved');
      const unreached = blockedSourceIds.length - outcomes.length;
      if (unresolved.length > 0 || unreached > 0) {
        const detailParts = [
          ...unresolved.map(o => `${o.sourceId} (${o.outcome})`),
          unreached > 0 ? `${unreached} not reached` : null,
        ].filter(Boolean);
        addToast({
          title: `Solved ${resolvedCount} of ${blockedSourceIds.length} sources`,
          description: `Still needs attention: ${detailParts.join(', ')}. Solve or skip them individually, or score what was gathered.`,
          type: 'info',
          dedupeKey: `job-solve-all-summary:${id}`,
        });
      }
      EventLogger.log(`[JobSearch][${id}] Solve all finished — ${resolvedCount}/${blockedSourceIds.length} resolved${unreached > 0 ? `, ${unreached} not reached` : ''}`);
    }
  }, [
    activeEnabledSourceIds, addToast, data, ensureBlockedSourceCards,
    getEdges, getNode, getNodes, id,
  ]);

  // Auto-start legacy drop-created hubs once per mounted node/path (must come
  // after startProcessing is declared — referencing it earlier would hit the
  // const TDZ on first render). A pipeline failure deliberately retains the
  // path so Try Again can re-parse it; the latch is what stops that failure
  // returning to `empty` from becoming an automatic restart loop. Comparing
  // the exact normalized path, rather than a boolean, still lets a genuinely
  // changed persisted path launch on this mounted node.
  useEffect(() => {
    const autoStartPath = typeof data.filePath === 'string' ? data.filePath.trim() : '';
    if (!autoStartPath || hubState !== 'empty' || processingRunsRef.current.active) return;
    if (isJobWorkflowDeletionPending(id)) return;
    if (autoStartedFilePathRef.current === autoStartPath) return;
    if (managedByJobBoard || activeBoardRecoveryOwnerKey) {
      EventLogger.log(`[JobSearch][${id}] Legacy file auto-start suppressed — connected Job Board owns search admission`);
      return;
    }
    // Do not consume the one-shot latch while the Board owns admission. If the
    // edge is removed before that Board runs, this effect re-evaluates and the
    // now-standalone legacy input remains runnable.
    autoStartedFilePathRef.current = autoStartPath;
    void Promise.resolve(startProcessing(autoStartPath)).then((outcome) => {
      // Deletion can become pending after this effect consumes the latch but
      // before the queued lane starts. Keep the durable file eligible so an
      // aborted OS deletion wakes the auto-start on the lifecycle revision.
      const blockedByDeletion = outcome?.error === 'This Job Search is pending deletion.'
        || (outcome?.status === 'cancelled' && isJobWorkflowDeletionPending(id));
      const claimedByBoard = ['paused', 'not-ready'].includes(outcome?.status)
        && !!findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges());
      if (
        (blockedByDeletion || claimedByBoard)
        && autoStartedFilePathRef.current === autoStartPath
      ) {
        autoStartedFilePathRef.current = null;
      }
    }).catch(() => {
      if (
        isJobWorkflowDeletionPending(id)
        && autoStartedFilePathRef.current === autoStartPath
      ) {
        autoStartedFilePathRef.current = null;
      }
    });
  }, [activeBoardRecoveryOwnerKey, data.filePath, deletionLifecycleRevision, getEdges, getNodes, hubState, id, managedByJobBoard, startProcessing]);

  // Handle file drops directly onto this node. Any NUMBER and TYPE of files are
  // accepted — they're merged into one "career data" blob downstream (résumé,
  // portfolio, project notes, brag doc, …). App bundles are filtered with a
  // clear message; everything else flows to the backend, which reads PDFs/DOCX
  // inline, images via vision, and falls back to utf8 text.
  const acceptCareerFiles = useCallback((paths, names = []) => {
    // Each hub is permanently bound to its INITIAL career-data upload. Once that
    // exists, further drops are refused — re-running a search reuses the same
    // résumé. Clear career data first, then import different files into this
    // same Job Search when a new career input is intended.
    if (initialDropAcceptedRef.current || dropLockReason || processingRunsRef.current.active) {
      EventLogger.log(`[JobSearch][${id}] Drop rejected: hub already started`);
      addToast({
        title: 'Career data is locked',
        description: 'This job search is tied to its current career files. Choose Clear career data, then import the different files before starting again.',
        type: 'info',
      });
      return;
    }
    const valid = [];
    paths.forEach((p, i) => {
      const nm = names[i] || p || '';
      if (!p) return;
      if (/\.app$/i.test(nm)) {
        EventLogger.log(`[JobSearch][${id}] Drop skipped: app bundle (${nm})`);
        return;
      }
      valid.push(p);
    });
    if (valid.length === 0) {
      addToast({
        title: 'No usable files',
        description: 'Drop PDF, DOCX, TXT, or image files of your career history (macOS apps are not accepted).',
        type: 'error',
      });
      return;
    }
    initialDropAcceptedRef.current = true;
    lastDroppedPathsRef.current = valid;
    const careerImportCapability = createJobCareerImportCapability(id);
    EventLogger.log(`[JobSearch][${id}] Drop accepted: ${valid.length} file(s)`);
    updateGlobal(id, {
      inputLocked: true,
      careerFilePaths: valid,
      careerImportGeneration: careerImportCapability,
      careerImportFreshCapability: careerImportCapability,
      careerImportConsumption: null,
    });
    if (deferDirectSearchToBoard(
      'Career-file drop',
      'Career files saved. Use Search selected & combine on the connected Job Board when you are ready.',
    )) return;
    startProcessingRef.current?.(valid);
  }, [addToast, deferDirectSearchToBoard, dropLockReason, id, updateGlobal]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer?.files || []);
    const exts = summarizeFileExtensions(files);
    const ingressReason = data.locked
      ? 'locked'
      : platformsVerifying
        ? 'platforms-verifying'
        : dropLockReason
          ? dropLockReason
          : PROCESSING_STATES.includes(hubState)
            ? `processing-${hubState}`
            : files.length === 0
              ? 'no-files'
              : null;
    EventLogger.log(
      `[JobSearch][${id}] Drop ingress: ${files.length} file(s) ext=[${exts.join(', ') || 'none'}] ` +
      `${ingressReason ? `rejected reason=${ingressReason}` : 'accepted-for-validation'}`
    );
    if (ingressReason) return;

    const payloads = filesToDropPayloads(files);
    acceptCareerFiles(payloads.map(file => file.path), payloads.map(file => file.name));
  }, [acceptCareerFiles, data.locked, dropLockReason, hubState, id, platformsVerifying]);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.hubId !== id) return;
      const droppedFiles = (e.detail?.files || []).filter(f => f?.filePath);
      const currentHubState = hubStateRef.current;
      const ingressReason = data.locked
        ? 'locked'
        : platformsVerifying
          ? 'platforms-verifying'
          : dropLockReason
            ? dropLockReason
            : PROCESSING_STATES.includes(currentHubState)
              ? `processing-${currentHubState}`
              : droppedFiles.length === 0
                ? 'no-valid-paths'
                : null;
      EventLogger.log(
        `[JobSearch][${id}] Document-node drop ingress: ${droppedFiles.length} file(s) ` +
        `${ingressReason ? `rejected reason=${ingressReason}` : 'accepted-for-validation'}`
      );
      if (ingressReason) return;
      acceptCareerFiles(droppedFiles.map(f => f.filePath), droppedFiles.map(f => f.filename));
    };
    document.addEventListener('canvas-file-nodes-dropped-on-hub', handler);
    return () => document.removeEventListener('canvas-file-nodes-dropped-on-hub', handler);
  }, [acceptCareerFiles, data.locked, dropLockReason, id, platformsVerifying]);

  const cancelActiveBoardChild = useCallback((reason) => {
    const control = boardRunControlRef.current;
    if (!control) return false;
    const exactCanceller = cancelBoardRunRef.current;
    if (typeof exactCanceller !== 'function') {
      // Registration installs the ref before exposing this runner, so this is a
      // defensive no-op rather than permission to fall through to the generic
      // reset path (which can cancel other Boards by this Search's queue alias).
      EventLogger.error(`[JobSearch][${id}] Exact Board cancellation was unavailable; generic reset suppressed`);
      return true;
    }
    void exactCanceller({
      orchestratorNodeId: control.orchestratorNodeId,
      boardRunId: control.boardRunId,
      reason,
    }).catch((error) => {
      EventLogger.error(`[JobSearch][${id}] Exact Board cancellation failed:`, error);
    });
    return true;
  }, [id]);

  const resetHandler = useCallback(async (e) => {
    e?.stopPropagation();
    if (cancelActiveBoardChild('board-child-cancelled')) {
      EventLogger.log(`[JobSearch][${id}] Child cancel routed through active Job Board rollback`);
      return;
    }
    if (standaloneCancellationRef.current) return;

    let cancellationToken = null;
    let cancellationReason = null;
    const claimStandaloneCancellation = () => {
      if (cancellationToken) return true;
      if (standaloneCancellationRef.current) return false;
      cancellationToken = Symbol('job-search-reset');
      cancellationReason = reanalysisRestoreRef.current
        ? 'reanalysis-cancelled'
        : 'user-reset';
      standaloneCancellationRef.current = cancellationToken;

      // Fence the currently running standalone generation before awaiting any
      // exact Board rollback. Otherwise that older run can settle during the
      // parent cancellation round-trips and mutate the state this Reset later
      // clears using a stale render closure.
      epoch.bump();
      moduleRunQueue.cancelQueuedRunsOwnedByNode(id);
      processingRunsRef.current.cancel();
      try {
        const cancellation = window.electronAPI?.cancelNodeTask?.(id, cancellationReason);
        if (cancellation && typeof cancellation.catch === 'function') {
          void cancellation.catch(() => {});
        }
      } catch {
        // The acknowledged manual-AI retirement path below will retry the
        // cancellation when this run has a durable handoff marker.
      }
      return true;
    };
    const releaseStandaloneCancellation = () => {
      if (
        cancellationToken
        && standaloneCancellationRef.current === cancellationToken
      ) {
        standaloneCancellationRef.current = null;
      }
    };
    // A Board persists ownership before it waits for the shared lane. The
    // Search may therefore still be executing an older standalone turn with no
    // in-memory boardRunControl. Route the Board reservation through its exact
    // parent identity first; generic alias cancellation would otherwise remove
    // that Board (and potentially another Board) without its rollback cleanup.
    // More than one Board can be queued behind the same older standalone Search.
    // Retire every queued reservation in durable order before resetting the
    // Search. Cancelling only the first owner would let the second Board begin
    // with state that the standalone Reset immediately erased.
    const cancelledQueuedBoardOwners = new Set();
    let durableBoardOwner = findJobSearchBoardActiveRecoveryOwner(
      id,
      getNodes(),
      getEdges(),
    );
    while (durableBoardOwner) {
      const durableBoardData = getNode(durableBoardOwner.orchestratorNodeId)?.data || {};
      const durableOwnerHasActiveChild = (
        durableBoardData?.boardScanResume?.activeSourceId === id
        || durableBoardData?.boardScanResume?.activeSourceIds?.includes(id)
        || durableBoardData?.boardCancellation?.sourceId === id
        || durableBoardData?.boardCancellation?.sourceIds?.includes(id)
      );
      if (!durableOwnerHasActiveChild && (getNode(id)?.data?.locked ?? data.locked)) break;
      if (!durableOwnerHasActiveChild && !claimStandaloneCancellation()) return;
      const durableOwnerKey = `${durableBoardOwner.orchestratorNodeId}:${durableBoardOwner.boardRunId || ''}`;
      if (cancelledQueuedBoardOwners.has(durableOwnerKey)) {
        EventLogger.error(`[JobSearch][${id}] Durable Board reservation remained after exact cancellation; standalone reset suppressed`);
        addToast({
          title: 'Cancellation not finished',
          description: 'An owning Job Board kept its recovery receipt. Cancel it from the Board and try again.',
          type: 'error',
        });
        releaseStandaloneCancellation();
        return;
      }
      cancelledQueuedBoardOwners.add(durableOwnerKey);
      let boardCancellation;
      try {
        boardCancellation = await jobSearchCoordinator.cancelBoardModule(
          durableBoardOwner.orchestratorNodeId,
          {
            boardRunId: durableBoardOwner.boardRunId,
            reason: 'board-child-cancelled',
          },
        );
      } catch (error) {
        EventLogger.error(`[JobSearch][${id}] Durable Board cancellation failed:`, error);
        addToast({
          title: 'Cancellation not finished',
          description: 'The owning Job Board kept its recovery receipt. Cancel it from the Board and try again.',
          type: 'error',
        });
        releaseStandaloneCancellation();
        return;
      }
      if (boardCancellation?.status === 'failed' || boardCancellation?.status === 'busy') {
        addToast({
          title: 'Cancellation still in progress',
          description: 'Wait for the owning Job Board cancellation to finish before resetting this Search.',
          type: 'info',
        });
        releaseStandaloneCancellation();
        return;
      }
      if (durableOwnerHasActiveChild && !cancellationToken) {
        EventLogger.log(`[JobSearch][${id}] Durable child cancel routed through Job Board rollback`);
        return;
      }

      // Board cancellation clears its durable plan through the global node
      // updater. Let that state become observable before electing the next
      // owner; otherwise the just-cancelled Board could be selected again and
      // hide another queued Board behind it.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await waitForRendererCommitFrame();
        const visibleOwner = findJobSearchBoardActiveRecoveryOwner(
          id,
          getNodes(),
          getEdges(),
        );
        const visibleOwnerKey = visibleOwner
          ? `${visibleOwner.orchestratorNodeId}:${visibleOwner.boardRunId || ''}`
          : null;
        if (visibleOwnerKey !== durableOwnerKey) break;
      }
      durableBoardOwner = findJobSearchBoardActiveRecoveryOwner(
        id,
        getNodes(),
        getEdges(),
      );
    }
    if (getNode(id)?.data?.locked ?? data.locked) {
      // A locked hub still renders this control, so the click reaches here and
      // then vanished without a trace. That made a real report ("I stopped it")
      // indistinguishable from one where the button was never pressed: nothing
      // in the event history, nothing in the backend task registry. Record the
      // refusal and say so, so the user is not left watching a run they believe
      // they cancelled.
      EventLogger.log(`[JobSearch][${id}] Cancel/Reset refused — hub is locked; backend tasks left running`);
      addToast({
        title: 'This job search is locked',
        description: 'Unlock the module to cancel its run. The search is still running in the background.',
        type: 'info',
      });
      releaseStandaloneCancellation();
      return;
    }

    if (hasPendingManualAiRetirement(getNode(id)?.data || {})) {
      EventLogger.log(`[JobSearch][${id}] Reset deferred: saved cancellation cleanup is still pending`);
      addToast({
        title: 'Finish Job Search Cleanup First',
        description: 'Use Try Again to finish the saved cancellation cleanup before resetting this module.',
        type: 'info',
      });
      releaseStandaloneCancellation();
      return;
    }

    if (!claimStandaloneCancellation()) return;
    const resetData = getNode(id)?.data || data;
    const manualMarker = getNode(id)?.data?.manualAiResume || null;
    const manualAiRunId = activeManualAiRunIdRef.current
      || manualMarker?.runId
      || null;

    // The renderer generation was already fenced by
    // claimStandaloneCancellation. Do not erase its durable recovery identity
    // until the node-scoped backend task and exact manual handoff retire.
    if (manualAiRunId) {
      try {
        await settleManualAiRetirement({
          runId: manualAiRunId,
          marker: manualMarker || { runId: manualAiRunId },
          retirementReason: cancellationReason,
          requireCancellationAck: true,
          cancellationReason,
        });
      } catch (error) {
        EventLogger.error(`[JobSearch][${id}] Manual-AI cancellation cleanup failed:`, error);
        addToast({
          title: 'Cancellation not finished',
          description: 'The saved AI handoff was kept so Reset can retry its cleanup safely.',
          type: 'error',
        });
        releaseStandaloneCancellation();
        return;
      }
    }
    releaseStandaloneCancellation();

    const reanalysisRestore = reanalysisRestoreRef.current;
    if (reanalysisRestore) {
      // The processing card uses this same cancel control for a full search
      // and for saved-result re-analysis. The latter must return to its prior
      // done state, not clear the listing set or its summary counters.
      EventLogger.log(`[JobSearch][${id}] Re-analysis cancelled; restoring prior hiring-fit results`);
      updateGlobal(id, {
        hubState: 'done',
        queuedModuleRun: null,
        manualAiResume: null,
        errorMessage: null,
        ...reanalysisRestore.patch,
      });
      reanalysisRestoreRef.current = null;
      return;
    }

    EventLogger.log(`[JobSearch][${id}] User clicked Reset`);

    // Bump the epoch so any in-flight runPipeline step that settles after
    // this point sees a mismatch and bails (doesn't overwrite the freshly-
    // reverted state or spawn orphan nodes).
    // Also clear filePath. The one-shot auto-start latch prevents a failed run
    // from recursively launching itself, but Reset is an explicit abandonment
    // of the input — the user clicked Cancel, not Retry. Once parsing produced a
    // reusable profile, the empty state still exposes an explicit Re-run Search
    // action backed by that profile.
    lastDroppedPathsRef.current = null;
    const resetRunId = jobRunIdRef.current || resetData.jobRunId || null;
    // If search-jobs already returned, the renderer owns the run token and can
    // discard its recovery sidecars directly. If Reset landed during the scrape,
    // the main-process abort path performs the same token-scoped cleanup because
    // the renderer has not received the run ID yet.
    if (resetRunId) {
      window.electronAPI?.discardJobRun?.({ canvasFilePath, nodeId: id, runId: resetRunId }).catch(() => {});
    }
    // Drop stale results too: an 'empty' hub must not keep scoredJobs from a prior
    // run — otherwise a connected Job Board could still read them (defense-in-depth
    // with the board's hubState!=='done' gate). Keep the initial career identity
    // only after parsing yielded a profile; cancelling while parsing used to leave
    // `inputLocked` behind with no profile and no possible recovery action.
    // The shared clear patch wipes a superset (the career-derived caches too),
    // which is strictly more correct here: those caches can only be non-null if
    // an earlier career life existed on this hub, in which case they are stale.
    const resetHasReusableCareerProfile = !!(
      resetData.resumeProfile
      && typeof resetData.resumeProfile === 'object'
    );
    const retainedCareerData = resetHasReusableCareerProfile ? {} : buildJobHubCareerClearPatch({
      // Reset does not discard analysis sidecars, so it must never lower a
      // watermark set by an earlier explicit Career Files clear.
      jobAnalysisClearedAt: resetData.jobAnalysisClearedAt ?? null,
      jobAnalysisClearedRunId: resetData.jobAnalysisClearedRunId ?? null,
    });
    // ROLE LOCKING: the lock is a career-data-scoped decision, so it clears
    // exactly when the career profile it was derived from also clears here
    // (the same condition guarding retainedCareerData above) — never on a
    // mere mid-run Cancel that keeps the profile, which must keep reusing its
    // locked roles for zero cost, per the "only career-data clear/hub reset
    // unlocks" rule.
    const roleLockClearPatch = resetHasReusableCareerProfile
      ? {}
      : { searchBriefPlan: null, resolvedRoles: null, resolvedRolesMeta: null };
    initialDropAcceptedRef.current = resetHasReusableCareerProfile;
    pendingJobsRef.current = null;
    gatheredCountRef.current = 0;
    scrapeWarningsRef.current = [];
    sourceWarningOverridesDuringSearchRef.current.clear();
    hubStateRef.current = 'empty';
    updateGlobal(id, {
      hubState: 'empty', queuedModuleRun: null, filePath: null, errorMessage: null, rerunOutcome: null, rerunNotice: null, testModeNote: null,      scoredJobs: null, finalSourceCounts: {}, resultCount: 0, totalScoredCount: 0, scrapedCount: 0, gatheredCount: 0, scoreThreshold: 0, jobRunId: null,
      manualAiResume: null,
      terminalFinalizationRecovery: null,
      aiSkipped: false, collectionOnly: false, testMode: false,
      resultDisposition: null,
      preferenceMatchedCount: null, preferenceFilteredCount: null,
      preferenceEvaluation: null, preferenceCandidatePool: null,
      activeTargetRole: null, activeJobPreferences: null, jobPreferencePlan: null, jobPreferencesInterpretation: null,
      pinnedTitles: null,
      pendingJobs: null, pendingTargetRole: null,
      pendingJobPreferences: null, pendingJobPreferencePlan: null, pendingJobPreferencesInterpretation: null,
      pendingCareerData: null,
      scrapeWarnings: [],
      collectionScopeCaveats: [],
      // A snapshot describes one completed/in-flight run, not the persistent
      // search settings. Leaving it behind lets a later legacy resume use an
      // abandoned residence while the visible fields show the new one.
      locationSnapshot: null,
      _boardRollbackSourceProgressFence: null,
      ...retainedCareerData,
      ...roleLockClearPatch,
    });
    jobRunIdRef.current = null;
    cancelCleanSourceCardDismiss();
    resetSourceProgress();
    cleanupAllJobChildren();
  }, [addToast, cancelActiveBoardChild, data, id, updateGlobal, epoch, resetSourceProgress, cleanupAllJobChildren, cancelCleanSourceCardDismiss, canvasFilePath, moduleRunQueue, getEdges, getNode, getNodes, jobSearchCoordinator, settleManualAiRetirement]);

  // Non-API scoring is controlled by an app-level dialog, outside this node.
  // Its Cancel action aborts the backend operation, then broadcasts the owning
  // node id here. The shared handler routes an active Board child through its
  // exact transaction rollback; standalone work retains the normal full reset.
  useEffect(() => {
    const onManualAiNodeCancelled = (event) => {
      const detail = event.detail || {};
      if (detail.nodeId !== id) return;
      if (!detail.runId) {
        // An unscoped legacy event cannot prove which generation it belongs
        // to. The pipeline that owned the dialog still observes its backend
        // cancellation, but this listener must not reset a newer Search or a
        // Board that has since queued against the same node.
        EventLogger.log(`[JobSearch][${id}] Ignoring unscoped manual-AI cancel notification`);
        return;
      }
      if (detail.runId && cancelledBoardManualAiRunIdsRef.current.has(detail.runId)) {
        EventLogger.log(`[JobSearch][${id}] Manual-AI cancel notification matched completed Board rollback`);
        return;
      }
      // A user cancel must not immediately relaunch the work it cancelled.
      // The retirement path below is async (it awaits a Board-owner sweep, the
      // lock/pending-cleanup gate, and settleManualAiRetirement), so for a few
      // seconds the node still carries its `manualAiResume` marker — and the
      // auto-resume effect, which fences on exactly this set, would fire in
      // that window. When the pending task is not a saved-scrape replay it
      // falls through to a FULL fresh multi-source search: cancelling a single
      // handoff would silently start hours of scraping. Claim the run id here,
      // before any early return below, so that cannot happen.
      rememberBoundedRunId(cancelledBoardManualAiRunIdsRef.current, detail.runId);
      const activeBoardControl = boardRunControlRef.current;
      if (
        detail.runId
        && activeBoardControl?.manualAiRunId
        && detail.runId !== activeBoardControl.manualAiRunId
      ) {
        EventLogger.log(
          `[JobSearch][${id}] Retiring stale manual-AI cancel notification for a different Board child run`,
        );
        void settleManualAiRetirement({
          runId: detail.runId,
          marker: { runId: detail.runId },
          retirementReason: 'superseded-by-board-run',
          superseded: true,
        }).catch((error) => {
          EventLogger.error(`[JobSearch][${id}] Stale Board handoff cleanup failed:`, error);
        });
        return;
      }
      const persistedManualRunId = getNode(id)?.data?.manualAiResume?.runId || null;
      const activeManualRunId = activeManualAiRunIdRef.current || persistedManualRunId;
      if (detail.runId && activeManualRunId && detail.runId !== activeManualRunId) {
        EventLogger.log(`[JobSearch][${id}] Retiring stale manual-AI cancel notification for an older run`);
        void settleManualAiRetirement({
          runId: detail.runId,
          marker: { runId: detail.runId },
          retirementReason: 'superseded-by-newer-run',
          superseded: true,
        }).catch((error) => {
          EventLogger.error(`[JobSearch][${id}] Stale handoff cleanup failed:`, error);
        });
        return;
      }
      if (detail.runId && persistedManualRunId === detail.runId) {
        const durableOwner = findJobSearchBoardRecoveryOwner(
          id,
          detail.runId,
          getNodes(),
          getEdges(),
        );
        if (
          durableOwner
          && !durableOwner.missingPlan
          && typeof cancelBoardRunRef.current === 'function'
        ) {
          void cancelBoardRunRef.current({
            orchestratorNodeId: durableOwner.orchestratorNodeId,
            boardRunId: durableOwner.boardRunId,
            reason: 'manual-ai-cancelled',
          }).catch((error) => {
            EventLogger.error(`[JobSearch][${id}] Durable Board cancellation failed:`, error);
          });
          return;
        }
        if (durableOwner?.missingPlan) {
          // The exact parent no longer exists. Honour cancellation without the
          // generic Reset path, which would erase completed Search data and
          // cancel unrelated Board queue aliases.
          epoch.bump();
          processingRunsRef.current.cancel();
          const marker = getNode(id)?.data?.manualAiResume || { runId: detail.runId };
          void settleManualAiRetirement({
            runId: detail.runId,
            marker,
            retirementReason: 'manual-ai-cancelled',
            requireCancellationAck: true,
            cancellationReason: 'manual-ai-cancelled',
          }).then(() => {
            updateGlobal(id, { queuedModuleRun: null });
          }).catch((error) => {
            EventLogger.error(`[JobSearch][${id}] Orphaned Board handoff cancellation failed:`, error);
          });
          return;
        }
      }
      resetHandler();
    };
    document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);
    return () => document.removeEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);
  }, [epoch, getEdges, getNode, getNodes, id, resetHandler, settleManualAiRetirement, updateGlobal]);

  // The global handoff dialog owns the pending request UI. Mirror only a small
  // restart marker onto the node so the normal canvas save captures which
  // logical workflow must be re-invoked after a process restart.
  useEffect(() => {
    const onPending = (event) => {
      const detail = event.detail || {};
      if (detail.nodeId !== id || !detail.runId) return;
      if (cancelledBoardManualAiRunIdsRef.current.has(detail.runId)) return;
      const boardControl = boardRunControlRef.current;
      const activeRunId = activeManualAiRunIdRef.current;
      if (activeRunId && activeRunId !== detail.runId) {
        EventLogger.log(`[JobSearch][${id}] Retiring stale manual-AI pending notification for a different active run`);
        void settleManualAiRetirement({
          runId: detail.runId,
          marker: {
            runId: detail.runId,
            task: detail.task || null,
            stepKey: detail.stepKey || null,
            recoveryMode: detail.recoveryMode || null,
          },
          retirementReason: 'superseded-by-newer-run',
          superseded: true,
        }).catch((error) => {
          EventLogger.error(`[JobSearch][${id}] Stale pending handoff cleanup failed:`, error);
        });
        return;
      }
      const persistedRunId = getNode(id)?.data?.manualAiResume?.runId || null;
      if (
        persistedRunId
        && persistedRunId !== detail.runId
        && boardControl?.manualAiRunId !== detail.runId
      ) {
        EventLogger.log(`[JobSearch][${id}] Retiring manual-AI pending notification superseded by another durable run`);
        void settleManualAiRetirement({
          runId: detail.runId,
          marker: {
            runId: detail.runId,
            task: detail.task || null,
            stepKey: detail.stepKey || null,
            recoveryMode: detail.recoveryMode || null,
          },
          retirementReason: 'superseded-by-durable-run',
          superseded: true,
        }).catch((error) => {
          EventLogger.error(`[JobSearch][${id}] Superseded pending handoff cleanup failed:`, error);
        });
        return;
      }
      activeManualAiRunIdRef.current = detail.runId;
      updateGlobal(id, (node) => {
        const existing = node?.data?.manualAiResume;
        if (
          existing?.runId
          && existing.runId !== detail.runId
          && boardControl?.manualAiRunId !== detail.runId
        ) return null;
        return {
          manualAiResume: {
            ...(existing?.runId === detail.runId ? existing : {}),
            runId: detail.runId,
            // The global manual-AI dialog identifies its own request, not the
            // Search generation that produced it. Persist the latter locally
            // so a waiting Board can refuse a same-Search but unrelated prompt
            // after reload. Legacy markers without this field retain their
            // backwards-compatible ownership fallback.
            jobRunId: existing?.runId === detail.runId && Object.hasOwn(existing, 'jobRunId')
              ? existing.jobRunId
              : (jobRunIdRef.current || node?.data?.jobRunId || null),
            task: detail.task || null,
            stepKey: detail.stepKey || null,
            recoveryMode: detail.recoveryMode || null,
            ...(boardControl?.manualAiRunId === detail.runId ? {
              orchestratorNodeId: boardControl.orchestratorNodeId,
              boardRunId: boardControl.boardRunId,
            } : {}),
            updatedAt: Date.now(),
          },
        };
      });
    };
    document.addEventListener('non-api-ai-node-pending', onPending);
    return () => {
      document.removeEventListener('non-api-ai-node-pending', onPending);
    };
  }, [getNode, id, settleManualAiRetirement, updateGlobal]);

  useEffect(() => {
    if (isJobWorkflowDeletionPending(id)) return;
    const receipts = normalizeManualAiCleanupReceipts(data.manualAiCleanupReceipts);
    const next = receipts.find(receipt => (
      !attemptedManualAiCleanupRunIdsRef.current.has(receipt.runId)
    ));
    const canSurfaceFailure = !processingRunsRef.current.active
      && !boardRunControlRef.current
      && !BOARD_BUSY_SEARCH_STATES.has(data.hubState || 'empty');
    if (!next) {
      const failedReceipt = receipts.find(receipt => receipt.cleanupError);
      if (failedReceipt && canSurfaceFailure) {
        updateGlobal(id, {
          errorMessage: failedReceipt.cleanupError,
        });
      }
      return;
    }
    attemptedManualAiCleanupRunIdsRef.current.add(next.runId);
    void settleManualAiRetirement({
      runId: next.runId,
      marker: next,
      retirementReason: next.retirementReason || 'superseded-cleanup',
      requireCancellationAck: next.cancellationPending === true,
      cancellationReason: next.cancellationReason || next.retirementReason || 'manual-ai-cancelled',
      superseded: true,
    }).catch((error) => {
      EventLogger.error(`[JobSearch][${id}] Superseded manual-AI cleanup retry failed run=${next.runId}:`, error);
      const liveData = getNode(id)?.data || {};
      const canSurfaceLiveFailure = !processingRunsRef.current.active
        && !boardRunControlRef.current
        && !BOARD_BUSY_SEARCH_STATES.has(liveData.hubState || 'empty');
      if (canSurfaceLiveFailure) {
        updateGlobal(id, {
          errorMessage: error?.message || 'An older saved manual-AI handoff still needs cleanup.',
        });
      }
    });
  }, [data.hubState, data.manualAiCleanupReceipts, deletionLifecycleRevision, getNode, id, settleManualAiRetirement, updateGlobal]);

  const handleRerun = useCallback(({
    frameSourceCards = true,
    queueManagedByBoard = false,
    parentCancelled = null,
    orchestratorNodeId = null,
    boardRunId = null,
    freshImportCapability = null,
    runOrigin = 'rerun-button',
    manualAiRunId = null,
  } = {}) => {
    if (isJobWorkflowDeletionPending(id)) {
      return searchRunOutcome('cancelled', { error: 'This Job Search is pending deletion.' });
    }
    if (hasPendingManualAiRetirement(getNode(id)?.data || {})) {
      return searchRunOutcome('not-ready', {
        error: 'Finish the older manual-AI cancellation cleanup before starting another search.',
      });
    }
    if (data.locked) {
      return searchRunOutcome('not-ready', { error: 'This Job Search module is locked.' });
    }
    if (processingRunsRef.current.active) {
      return searchRunOutcome('busy', { error: 'This Job Search module is already running.' });
    }
    if (getNode(id)?.data?.terminalFinalizationRecovery) {
      return searchRunOutcome('not-ready', {
        error: 'Finish the interrupted job-run cleanup before starting another search.',
      });
    }
    if (!queueManagedByBoard && deferDirectSearchToBoard('Direct re-run')) {
      return searchRunOutcome('not-ready', { error: 'Run this connected search from its Job Board.' });
    }
    if (platformsVerifying) {
      EventLogger.log(`[JobSearch][${id}] Re-run deferred — selected platform connection verification is still pending`);
      addToast({
        title: 'Checking Connections',
        description: 'Wait for the selected job platform connection check to finish, then re-run the search.',
        type: 'info',
      });
      return searchRunOutcome('not-ready', {
        error: 'Its selected platform connections are still being checked.',
        ...(queueManagedByBoard ? { transientReason: 'platforms-verifying' } : {}),
      });
    }
    if (activeEnabledSourceIds.length === 0) {
      const message = 'Select at least one job platform before running the search.';
      // Logged BEFORE the "Re-run button clicked" line this handler emits later,
      // so a report cannot show the click without the reason the banner appeared.
      EventLogger.log(`[JobSearch][${id}] Re-run refused — error banner raised: ${message}`);
      updateGlobal(id, { errorMessage: message, rerunOutcome: null, rerunNotice: null });
      addToast({ title: 'Choose a Job Platform', description: message, type: 'error' });
      return searchRunOutcome('not-ready', { error: message });
    }
    const droppedPaths = lastDroppedPathsRef.current;
    const effectivePaths = (Array.isArray(droppedPaths) && droppedPaths.length)
      ? droppedPaths
      : (Array.isArray(data.careerFilePaths) && data.careerFilePaths.length)
        ? data.careerFilePaths.filter(Boolean)
        : (Array.isArray(data.filePaths) && data.filePaths.length)
          ? data.filePaths.filter(Boolean)
          : (data.filePath ? [data.filePath] : []);
    if (effectivePaths.length === 0 && !data.resumeProfile) {
      updateGlobal(id, { rerunOutcome: null, rerunNotice: null });
      addToast({ title: 'No Career Files', description: 'Drop your career files onto the hub to search again.', type: 'error' });
      return searchRunOutcome('not-ready', {
        error: 'This Job Search module has no career files or stored profile.',
      });
    }

    // (No result tree to remove — the cascade lives on the Job Board Module,
    // which detects this hub's new data via its staleness signature and
    // prompts a re-combine. Source-card tiles persist across re-runs.)

    const profileInputMode = effectivePaths.length > 0 ? 'fresh-files' : 'stored-profile';
    EventLogger.log(queueManagedByBoard
      ? `[JobSearch][${id}] Job Board requested search; career input=${profileInputMode}`
      : `[JobSearch][${id}] Re-run button clicked; career input=${profileInputMode}`);
    if (effectivePaths.length > 0) {
      // Files still accessible — re-parse for freshness then run full pipeline
      if (typeof startProcessingRef.current !== 'function') {
        return searchRunOutcome('failed', { error: 'Job Search processing is unavailable.' });
      }
      return startProcessingRef.current(effectivePaths, {
        frameSourceCards,
        runOrigin,
        manualAiRunId,
        queueManagedByBoard,
        parentCancelled,
        orchestratorNodeId,
        boardRunId,
        freshImportCapability,
      });
    } else {
      // Files gone but profile is persisted — run from query step onward
      if (!queueManagedByBoard) {
        addToast({ title: 'Re-running Search', description: 'Using stored career profile — original files not needed.', type: 'info' });
      }
      return startProcessingWithProfile(data.resumeProfile, {
        frameSourceCards,
        runOrigin,
        manualAiRunId,
        queueManagedByBoard,
        parentCancelled,
        orchestratorNodeId,
        boardRunId,
        freshImportCapability,
      });
    }
  }, [data.locked, data.filePath, data.filePaths, data.careerFilePaths, data.resumeProfile, id, addToast, getNode, startProcessingWithProfile, updateGlobal, activeEnabledSourceIds, deferDirectSearchToBoard, platformsVerifying]);

  const cancelBoardRun = useCallback(async ({
    orchestratorNodeId,
    boardRunId,
    reason = 'job-board-cancelled',
    queueManagedExternally = false,
    durablePlanOverride = null,
  } = {}) => {
    const control = boardRunControlRef.current;
    if (control && (
      control.orchestratorNodeId !== orchestratorNodeId
      || control.boardRunId !== boardRunId
    )) {
      // A different Board currently owns this hub. A queued/recovered Board's
      // durable marker is not authority to cancel or discard that live run.
      return { status: 'stale', cancelled: false };
    }

    // Keep every manual-AI ledger discovered while cancelling a child on the
    // durable Board plan. A cancellation acknowledgement can reveal a run that
    // the renderer had not published yet, so the legacy singular field alone
    // is not sufficient. The nonce makes the React write itself observable
    // before any of those external ledgers are completed.
    const persistChildCancellationCleanup = async (cleanupPatch = {}) => {
      const planAtWrite = getNode(orchestratorNodeId)?.data?.boardScanResume;
      if (planAtWrite?.boardRunId !== boardRunId) return false;
      const commitNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const requestedRunIds = [
        ...(Array.isArray(cleanupPatch.manualAiRunIds)
          ? cleanupPatch.manualAiRunIds
          : []),
        cleanupPatch.manualAiRunId,
      ].filter(runId => typeof runId === 'string' && runId);
      updateGlobal(orchestratorNodeId, (node) => {
        const livePlan = node?.data?.boardScanResume;
        if (livePlan?.boardRunId !== boardRunId) return null;
        const liveCleanup = livePlan.cancellationCleanup || {};
        const cleanupSourceId = cleanupPatch.sourceId || id;
        const cleanupBySource = livePlan.cancellationCleanupsBySource || {};
        const sourceCleanup = cleanupBySource[cleanupSourceId] || (
          liveCleanup.sourceId === cleanupSourceId ? liveCleanup : {}
        );
        const manualAiRunIds = [...new Set([
          ...(Array.isArray(sourceCleanup.manualAiRunIds)
            ? sourceCleanup.manualAiRunIds
            : []),
          sourceCleanup.manualAiRunId,
          ...requestedRunIds,
        ].filter(runId => typeof runId === 'string' && runId))];
        const nextSourceCleanup = {
          ...sourceCleanup,
          ...cleanupPatch,
          sourceId: cleanupSourceId,
          manualAiRunId: cleanupPatch.manualAiRunId
            || sourceCleanup.manualAiRunId
            || manualAiRunIds[0]
            || null,
          manualAiRunIds,
          commitNonce,
        };
        return {
          boardScanResume: {
            ...livePlan,
            cancellationCleanupsBySource: {
              ...cleanupBySource,
              [cleanupSourceId]: nextSourceCleanup,
            },
            // Compatibility bridge only: never merge fields from the prior
            // source's receipt into this source's durable cleanup ledger.
            cancellationCleanup: { ...nextSourceCleanup },
            updatedAt: Date.now(),
          },
        };
      });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await waitForRendererCommitFrame();
        const livePlan = getNode(orchestratorNodeId)?.data?.boardScanResume;
        if (livePlan?.boardRunId !== boardRunId) return false;
        const liveCleanup = livePlan.cancellationCleanupsBySource?.[cleanupPatch.sourceId || id]
          || livePlan.cancellationCleanup;
        if (liveCleanup?.commitNonce !== commitNonce) continue;
        const liveRunIds = new Set([
          ...(Array.isArray(liveCleanup.manualAiRunIds)
            ? liveCleanup.manualAiRunIds
            : []),
          liveCleanup.manualAiRunId,
        ].filter(Boolean));
        if (requestedRunIds.every(runId => liveRunIds.has(runId))) return true;
      }
      throw new Error('The Job Board child-cancellation receipt was not committed to the canvas.');
    };

    if (!control) {
      // After a reload there is intentionally no in-memory control yet. A
      // persisted Board plan is the only authority allowed to retire that
      // exact child before auto-resume starts (for example while login checks
      // are still pending). Verify the complete graph claim before touching
      // the child or its staged sidecar.
      const boardPlan = getNode(orchestratorNodeId)?.data?.boardScanResume
        || durablePlanOverride;
      const liveResume = getNode(id)?.data?.manualAiResume || null;
      const durableRollbackReceipt = boardPlan?.activeSourceRollback?.version === 1
        && boardPlan.activeSourceRollback.sourceId === id
        ? boardPlan.activeSourceRollback
        : (boardPlan?.activeSourceRollbacks?.[id]?.version === 1
          && boardPlan.activeSourceRollbacks[id].sourceId === id
          ? boardPlan.activeSourceRollbacks[id]
          : null);
      const exactPersistedMarker = liveResume?.runId
        && liveResume.orchestratorNodeId === orchestratorNodeId
        && liveResume.boardRunId === boardRunId;
      const durablePlanClaim = boardPlan?.version === 1
        && boardPlan.boardRunId === boardRunId
        && boardPlan.phase === 'searches'
        && (boardPlan.activeSourceId === id
          || (Array.isArray(boardPlan.activeSourceIds) && boardPlan.activeSourceIds.includes(id)))
        && Array.isArray(boardPlan.selectedSearchModuleIds)
        && boardPlan.selectedSearchModuleIds.includes(id);
      // The user may disconnect the edge specifically to remove this Search
      // from the interrupted Board. The still-live exact plan remains valid
      // cancellation authority long enough to retire that child's ledger;
      // requiring the edge here would strand the recovery artifacts.
      const durableClaim = exactPersistedMarker || durablePlanClaim;
      if (!durableClaim) return { status: 'stale', cancelled: false };

      const persistedCleanup = boardPlan?.cancellationCleanupsBySource?.[id]
        || (boardPlan?.cancellationCleanup?.sourceId === id
          ? boardPlan.cancellationCleanup
          : null);
      const persistedCleanupHasPriorRun = Object.prototype.hasOwnProperty.call(
        persistedCleanup || {},
        'priorRunId',
      );
      const hasDurablePriorRunProof = persistedCleanupHasPriorRun || !!durableRollbackReceipt;
      const persistedPriorRunId = persistedCleanupHasPriorRun
        ? (persistedCleanup.priorRunId || null)
        : (durableRollbackReceipt?.previousData?.jobRunId || null);
      const boardTerminalFinalizationRecovery = boardPlan?.recoverableFailure?.kind === 'terminal-finalization'
        && boardPlan.recoverableFailure.sourceId === id
        ? boardPlan.recoverableFailure
        : null;
      const searchTerminalFinalizationRecovery = getNode(id)?.data?.terminalFinalizationRecovery?.kind === 'terminal-finalization'
        ? getNode(id).data.terminalFinalizationRecovery
        : null;
      const terminalFinalizationRecovery = boardTerminalFinalizationRecovery
        || searchTerminalFinalizationRecovery;

      // Reserve the same global lane used by every Job Board/Search before the
      // first await below. Reload-time cancellation may need to discover the
      // staged run token from disk; without this reservation a newer Board can
      // create its ledger while the old cancellation is waiting, and the old
      // peek would then discard the new run. A synthetic owner id keeps node
      // cleanup from cancelling this safety barrier after the Board is deleted.
      const cancellationLeaseOwnerId = `job-search-durable-cancel:${id}:${boardRunId}`;
      const cancellationLeasePromise = queueManagedExternally
        ? Promise.resolve(null)
        : moduleRunQueue.acquireModuleRun({
            nodeId: cancellationLeaseOwnerId,
            kind: 'job-search-cancel',
            lane: 'job-search',
            label: 'Cancel interrupted Job Board search',
          });

      const ownsPersistedMarker = !!(
        liveResume?.runId
        && (!liveResume.orchestratorNodeId || liveResume.orchestratorNodeId === orchestratorNodeId)
        && (!liveResume.boardRunId || liveResume.boardRunId === boardRunId)
      );
      const cancellationManualAiRunIds = new Set([
        ...(Array.isArray(persistedCleanup?.manualAiRunIds)
          ? persistedCleanup.manualAiRunIds
          : []),
        persistedCleanup?.manualAiRunId,
        boardPlan?.activeSourceManualAiRunIds?.[id],
        ownsPersistedMarker ? liveResume.runId : null,
      ].filter(Boolean));
      let cancellationManualAiRunId = persistedCleanup?.manualAiRunId
        || (ownsPersistedMarker ? liveResume.runId : null)
        || [...cancellationManualAiRunIds][0]
        || null;
      if (ownsPersistedMarker) {
        rememberBoundedRunId(cancelledBoardManualAiRunIdsRef.current, liveResume.runId);
        if (activeManualAiRunIdRef.current === liveResume.runId) activeManualAiRunIdRef.current = null;
      }
      epoch.bump();
      processingRunsRef.current.cancel();
      // A scrape-phase interruption may have no renderer token at all. Retire
      // only the exact hub-owned resumable ledger discovered under the main
      // process lock; never guess a run id from the Board baseline.
      let recoveredRunId = persistedCleanup?.runId || null;
      let runCleanupAuthorized = persistedCleanup?.runCleanupAuthorized === true
        || !!(
          recoveredRunId
          && hasDurablePriorRunProof
          && (
            persistedCleanup?.ownsExistingRecoveryRun === true
            || recoveredRunId !== persistedPriorRunId
          )
        );
      let cancellationLease = null;
      let cancellationAcknowledged = false;
      let manualAiRetirementCompleted = false;
      try {
        // This first durable child intent is also inside the lease cleanup
        // boundary. The safety lease was deliberately reserved before any await;
        // if this commit fails, the catch below must cancel/observe that queued
        // promise (or release an already-started lease) instead of leaking it.
        const boardCleanupIntentPersisted = await persistChildCancellationCleanup({
          sourceId: id,
          runId: persistedCleanup?.runId || null,
          manualAiRunId: cancellationManualAiRunId,
          manualAiRunIds: [...cancellationManualAiRunIds],
          priorRunId: persistedPriorRunId,
          ownsExistingRecoveryRun: persistedCleanup?.ownsExistingRecoveryRun === true,
          runCleanupAuthorized: persistedCleanup?.runCleanupAuthorized === true,
        });
        updateGlobal(id, {
          queuedModuleRun: null,
          // If the Board disappeared while an override was being cancelled, its
          // plan cannot protect the only known ledger. Leave the exact Search
          // marker in place until post-ack cleanup persists its own receipts.
          ...(ownsPersistedMarker && boardCleanupIntentPersisted
            ? { manualAiResume: null }
            : {}),
          ...(terminalFinalizationRecovery ? {
            terminalFinalizationRecovery: {
              ...terminalFinalizationRecovery,
              updatedAt: Date.now(),
            },
          } : {}),
        });

        // Reload/navigation removes the in-memory Board control before the old
        // main-process search necessarily settles. Abort it immediately instead
        // of waiting behind the very lane holder we need to stop. The already-
        // enqueued safety lease is awaited only after acknowledgement and before
        // inspecting/deleting sidecars, so no later turn can interleave there.
        if (!window.electronAPI?.cancelNodeTaskAndWait) {
          window.electronAPI?.cancelNodeTask?.(id, reason);
          throw new Error('Acknowledged Job Search cancellation is unavailable.');
        }
        const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);
        if (acknowledgement?.settled !== true) {
          throw new Error('The interrupted Job Search did not finish cancelling before the safety timeout.');
        }
        cancellationAcknowledged = true;
        for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || []) {
          if (acknowledgedRunId) cancellationManualAiRunIds.add(acknowledgedRunId);
        }
        cancellationManualAiRunId = cancellationManualAiRunId
          || [...cancellationManualAiRunIds][0]
          || null;
        if (cancellationManualAiRunId) {
          await settleManualAiRetirement({
            runId: cancellationManualAiRunId,
            marker: liveResume?.runId === cancellationManualAiRunId ? liveResume : null,
            retirementReason: reason,
            cancellationReason: reason,
            acknowledgedRunIds: [...cancellationManualAiRunIds],
            beforeRetirement: acknowledgedIds => persistChildCancellationCleanup({
              sourceId: id,
              runId: recoveredRunId,
              manualAiRunId: cancellationManualAiRunId,
              manualAiRunIds: acknowledgedIds,
              priorRunId: persistedPriorRunId,
              ownsExistingRecoveryRun: persistedCleanup?.ownsExistingRecoveryRun === true,
              runCleanupAuthorized,
            }),
          });
          manualAiRetirementCompleted = true;
        } else {
          // Even a cancellation with no manual handoff must keep its child
          // cleanup target durable before the disk-inspection lease is entered.
          await persistChildCancellationCleanup({
            sourceId: id,
            runId: recoveredRunId,
            manualAiRunId: null,
            manualAiRunIds: [],
            priorRunId: persistedPriorRunId,
            ownsExistingRecoveryRun: persistedCleanup?.ownsExistingRecoveryRun === true,
            runCleanupAuthorized,
          });
        }
        cancellationLease = await cancellationLeasePromise;
        if (!recoveredRunId) {
          const info = await window.electronAPI?.peekJobRun?.({ canvasFilePath, nodeId: id });
          if (info?.success === false) {
            throw new Error(info.error || 'Could not inspect the interrupted Job Search before cancellation.');
          }
          if (
            info?.found
            && info?.nodeId === id
            && typeof info?.runId === 'string'
            && info.runId
          ) {
            recoveredRunId = info.runId;
            runCleanupAuthorized = runCleanupAuthorized || (
              hasDurablePriorRunProof
              && (
                persistedCleanup?.ownsExistingRecoveryRun === true
                || info.runId !== persistedPriorRunId
              )
            );
          }
        }
        if (
          terminalFinalizationRecovery?.runId
          && recoveredRunId
          && terminalFinalizationRecovery.runId !== recoveredRunId
        ) {
          throw new Error('The terminal Job Search recovery token changed before cancellation settled.');
        }
        if (recoveredRunId && persistedCleanup?.runId !== recoveredRunId) {
          await persistChildCancellationCleanup({
            sourceId: id,
            runId: recoveredRunId,
            manualAiRunId: cancellationManualAiRunId,
            manualAiRunIds: [...cancellationManualAiRunIds],
            priorRunId: persistedPriorRunId,
            ownsExistingRecoveryRun: persistedCleanup?.ownsExistingRecoveryRun === true,
            runCleanupAuthorized,
          });
        }
        if (recoveredRunId && runCleanupAuthorized && !terminalFinalizationRecovery) {
          const [runCleanup, analysisCleanup] = await Promise.all([
            window.electronAPI?.discardJobRun?.({ canvasFilePath, nodeId: id, runId: recoveredRunId }),
            window.electronAPI?.discardJobAnalysisSnapshot?.({ canvasFilePath, nodeId: id, runId: recoveredRunId }),
          ]);
          const runRetired = runCleanup?.ok === true && (
            runCleanup.cleared === true || runCleanup.absent === true || runCleanup.tokenMismatch === true
          );
          if (!runRetired || analysisCleanup?.ok !== true) {
            throw new Error('Durable Job Search recovery cleanup could not be verified.');
          }
        }
        // A terminal-finalization failure already committed a valid new result.
        // Cancelling that cleanup-only Board turn must leave the result and its
        // exact retry descriptor together; reverting to the pre-run snapshot
        // while preserving the new ledger would make both states unusable.
        if (durableRollbackReceipt && !terminalFinalizationRecovery) {
          const rollback = {
            ...boardRunRollbackPatch(safeClone(durableRollbackReceipt.previousData || {}), id),
            _boardRollbackSourceProgressFence: {
              nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            },
          };
          pendingJobsRef.current = null;
          gatheredCountRef.current = rollback.gatheredCount ?? 0;
          scrapeWarningsRef.current = Array.isArray(rollback.scrapeWarnings) ? rollback.scrapeWarnings : [];
          hubStateRef.current = rollback.hubState;
          jobRunIdRef.current = rollback.jobRunId || null;
          sourceWarningOverridesDuringSearchRef.current.clear();
          cancelCleanSourceCardDismiss();
          resetSourceProgress({ rejectUntilNextReset: true });
          const restoredSourceGraph = restoreBoardSourceGraph(
            durableRollbackReceipt.sourceGraph,
            recoveredRunId,
          );
          updateGlobal(id, rollback);
          const rollbackCommitted = restoredSourceGraph
            ? await waitForBoardRollbackCommit({
                getNode,
                getNodes,
                getEdges,
                nodeId: id,
                rollback,
                sourceGraph: restoredSourceGraph,
              })
            : !getNode(id);
          if (!rollbackCommitted) {
            throw new Error('The durable Job Search rollback was not committed to the canvas.');
          }
        }
      } catch (error) {
        if (!cancellationLease && !queueManagedExternally) {
          moduleRunQueue.cancelQueuedRunsForNode(
            cancellationLeaseOwnerId,
            'Durable Job Search cancellation failed before cleanup admission',
          );
          // Observe the queued promise's cancellation rejection so it cannot
          // become an unhandled rejection or later acquire an orphaned lease.
          try { cancellationLease = await cancellationLeasePromise; } catch { /* cancelled queue entry */ }
        }
        EventLogger.error(`[JobSearch][${id}] Could not fully retire durable Board recovery:`, error);
        if (!manualAiRetirementCompleted && cancellationManualAiRunIds.size > 0) {
          const cleanupError = error?.message
            || 'Durable Job Search cancellation cleanup did not finish.';
          updateGlobal(id, (node) => {
            let nextMarker = node?.data?.manualAiResume || null;
            let nextReceipts = normalizeManualAiCleanupReceipts(
              node?.data?.manualAiCleanupReceipts,
            );
            for (const cleanupRunId of cancellationManualAiRunIds) {
              const existingDescriptor = nextMarker?.runId === cleanupRunId
                ? nextMarker
                : nextReceipts.find(receipt => receipt.runId === cleanupRunId)
                  || (liveResume?.runId === cleanupRunId ? liveResume : {});
              const retryReceipt = {
                ...existingDescriptor,
                runId: cleanupRunId,
                orchestratorNodeId,
                boardRunId,
                retirementPending: true,
                retirementReason: reason,
                cancellationPending: !cancellationAcknowledged,
                cancellationReason: reason,
                cleanupError,
                updatedAt: Date.now(),
              };
              if (
                nextMarker?.runId === cleanupRunId
                || (!nextMarker && cleanupRunId === cancellationManualAiRunId)
              ) {
                nextMarker = retryReceipt;
                nextReceipts = removeManualAiCleanupReceipt(nextReceipts, cleanupRunId);
              } else {
                nextReceipts = upsertManualAiCleanupReceipt(nextReceipts, retryReceipt);
              }
            }
            return {
              manualAiResume: nextMarker,
              manualAiCleanupReceipts: nextReceipts.length > 0 ? nextReceipts : null,
              errorMessage: cleanupError,
            };
          });
          for (let attempt = 0; attempt < 4; attempt += 1) {
            await waitForRendererCommitFrame();
            const liveData = getNode(id)?.data || {};
            const receipts = normalizeManualAiCleanupReceipts(
              liveData.manualAiCleanupReceipts,
            );
            const allVisible = [...cancellationManualAiRunIds].every(cleanupRunId => (
              (liveData.manualAiResume?.runId === cleanupRunId
                && liveData.manualAiResume.retirementPending)
              || receipts.some(receipt => (
                receipt.runId === cleanupRunId && receipt.retirementPending
              ))
            ));
            if (allVisible) break;
          }
        }
        throw boardCancellationCleanupError(error, 'Durable Job Search recovery cleanup could not be verified.');
      } finally {
        cancellationLease?.release();
      }
      return { status: 'cancelled', cancelled: true, runId: recoveredRunId };
    }
    if (control.rollbackApplied) {
      const [rollbackResult, cleanupResult] = await Promise.allSettled([
        control.rollbackPromise,
        typeof control.cleanupArtifacts === 'function' ? control.cleanupArtifacts() : Promise.resolve(),
      ]);
      if (rollbackResult.status === 'rejected' || rollbackResult.value !== true) {
        throw boardCancellationCleanupError(null, 'The Job Search rollback was not committed to the canvas.');
      }
      if (cleanupResult.status === 'rejected') {
        throw boardCancellationCleanupError(cleanupResult.reason);
      }
      return { status: 'cancelled', cancelled: true, runId: control.cancelledRunId || null };
    }

    // Flip the shared predicate before any state/IPC work. Every awaited stage
    // in runPipeline observes this record, so a late backend settlement cannot
    // publish over the restored result snapshot.
    control.cancelled = true;
    control.rollbackApplied = true;
    const controlManualAiRunIds = control.manualAiRunIds instanceof Set
      ? control.manualAiRunIds
      : new Set([control.manualAiRunId].filter(Boolean));
    control.manualAiRunIds = controlManualAiRunIds;
    for (const ownedRunId of controlManualAiRunIds) {
      rememberBoundedRunId(cancelledBoardManualAiRunIdsRef.current, ownedRunId);
    }

    const live = getNode(id)?.data || {};
    const priorRunId = control.priorRunId || null;
    const liveRunId = live.jobRunId || null;
    const activeRunId = control.cancelledRunId
      || (jobRunIdRef.current && (
        jobRunIdRef.current !== priorRunId || control.ownsExistingRecoveryRun
      ) ? jobRunIdRef.current : null)
      || (liveRunId !== priorRunId ? liveRunId : null);
    const runCleanupAuthorized = !!activeRunId && (
      control.ownsExistingRecoveryRun === true || activeRunId !== priorRunId
    );
    control.cancelledRunId = activeRunId || null;

    EventLogger.log(
      `[JobSearch][${id}] Board run cancelled board=${orchestratorNodeId} run=${boardRunId}`,
    );
    epoch.bump();
    // This Board's active child already owns its queue lease, and the Board
    // cancels its own not-yet-started turns by board id. Do not cancel by this
    // source id here: it is also a cancellation alias on other Boards' queued
    // turns, so doing so would let Board A clear Board B's independent scan.
    const abortAndDiscoverRun = async () => {
      await persistChildCancellationCleanup({
        sourceId: id,
        runId: control.cancelledRunId || activeRunId || null,
        manualAiRunId: control.manualAiRunId || [...controlManualAiRunIds][0] || null,
        manualAiRunIds: [...controlManualAiRunIds],
        priorRunId,
        ownsExistingRecoveryRun: control.ownsExistingRecoveryRun === true,
        runCleanupAuthorized: control.runCleanupAuthorized === true || runCleanupAuthorized,
      });
      if (!window.electronAPI?.cancelNodeTaskAndWait) {
        window.electronAPI?.cancelNodeTask?.(id, reason);
        throw new Error('Acknowledged Job Search cancellation is unavailable.');
      }
      const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);
      if (acknowledgement?.settled !== true) {
        throw new Error('The active Job Search did not finish cancelling before the safety timeout.');
      }
      for (const acknowledgedRunId of acknowledgement?.manualAiRunIds || []) {
        if (!acknowledgedRunId) continue;
        controlManualAiRunIds.add(acknowledgedRunId);
        rememberBoundedRunId(cancelledBoardManualAiRunIdsRef.current, acknowledgedRunId);
      }
      const primaryManualAiRunId = control.manualAiRunId
        || [...controlManualAiRunIds][0]
        || null;
      if (primaryManualAiRunId) {
        const liveMarker = getNode(id)?.data?.manualAiResume;
        await settleManualAiRetirement({
          runId: primaryManualAiRunId,
          marker: liveMarker?.runId === primaryManualAiRunId ? liveMarker : null,
          retirementReason: reason,
          cancellationReason: reason,
          acknowledgedRunIds: [...controlManualAiRunIds],
          beforeRetirement: acknowledgedIds => persistChildCancellationCleanup({
            sourceId: id,
            runId: control.cancelledRunId || activeRunId || null,
            manualAiRunId: primaryManualAiRunId,
            manualAiRunIds: acknowledgedIds,
            priorRunId,
            ownsExistingRecoveryRun: control.ownsExistingRecoveryRun === true,
            runCleanupAuthorized: control.runCleanupAuthorized === true || runCleanupAuthorized,
          }),
        });
      } else {
        await persistChildCancellationCleanup({
          sourceId: id,
          runId: control.cancelledRunId || activeRunId || null,
          manualAiRunId: null,
          manualAiRunIds: [],
          priorRunId,
          ownsExistingRecoveryRun: control.ownsExistingRecoveryRun === true,
          runCleanupAuthorized: control.runCleanupAuthorized === true || runCleanupAuthorized,
        });
      }
      if (!canvasFilePath || !window.electronAPI?.peekJobRun) return;
      const info = await window.electronAPI.peekJobRun({ canvasFilePath, nodeId: id });
      if (info?.success === false) {
        throw new Error(info.error || 'Could not inspect the cancelled Job Search recovery files.');
      }
      if (
        info?.found
        && info?.nodeId === id
        && typeof info?.runId === 'string'
        && info.runId
      ) {
        if (control.cancelledRunId && control.cancelledRunId !== info.runId) {
          throw new Error('The Job Search recovery token changed while cancellation was settling.');
        }
        control.cancelledRunId = info.runId;
        control.runCleanupAuthorized = control.ownsExistingRecoveryRun === true
          || info.runId !== priorRunId;
        await persistChildCancellationCleanup({
          sourceId: id,
          runId: info.runId,
          manualAiRunId: primaryManualAiRunId,
          manualAiRunIds: [...controlManualAiRunIds],
          priorRunId,
          ownsExistingRecoveryRun: control.ownsExistingRecoveryRun === true,
          runCleanupAuthorized: control.runCleanupAuthorized,
        });
      }
    };
    const rollback = {
      ...boardRunRollbackPatch(control.previousData, id),
      _boardRollbackSourceProgressFence: {
        nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      },
    };
    pendingJobsRef.current = null;
    gatheredCountRef.current = rollback.gatheredCount ?? 0;
    scrapeWarningsRef.current = Array.isArray(rollback.scrapeWarnings) ? rollback.scrapeWarnings : [];
    hubStateRef.current = rollback.hubState;
    jobRunIdRef.current = rollback.jobRunId || null;
    sourceWarningOverridesDuringSearchRef.current.clear();
    cancelCleanSourceCardDismiss();
    processingRunsRef.current.cancel();
    const canRestoreCanvas = isMountedRef.current && getNode(id)?.type === 'jobhub';
    if (canRestoreCanvas) {
      resetSourceProgress({ rejectUntilNextReset: true });
      const restoredSourceGraph = restoreBoardSourceGraph(control.previousSourceGraph, activeRunId);
      updateGlobal(id, rollback);
      control.rollbackPromise = restoredSourceGraph
        ? waitForBoardRollbackCommit({
            getNode,
            getNodes,
            getEdges,
            nodeId: id,
            rollback,
            sourceGraph: restoredSourceGraph,
          })
        : Promise.resolve(!getNode(id));
    } else {
      // The old canvas no longer exists. Backend/manual ownership was still
      // retired above, but no old source nodes may be written into a new canvas.
      control.rollbackPromise = Promise.resolve(true);
    }

    // Retire only artifacts proven to belong to the abandoned Board turn. A
    // prior completed run is intentionally left intact so its restored results
    // and recovery snapshot remain coherent. Keep this retryable on the control:
    // a failed first cleanup leaves the Board plan intact and Cancel can verify
    // the exact same targets again without depending on rolled-back hub fields.
    const performCleanupArtifacts = async () => {
      // Create a fresh acknowledgement/inspection attempt on every Cancel
      // retry after a failed attempt. Concurrent cancellation surfaces must,
      // however, share this attempt: the dialog event and the rejected worker
      // can otherwise overwrite each other's durable commit nonce and run the
      // same acknowledged cleanup twice.
      await abortAndDiscoverRun();
      // Cancelling a cleanup-only terminal retry must preserve both the exact
      // run ledger and its analysis/prompt snapshot. The Search result is valid;
      // only its idempotent completion transaction remains retryable.
      if (control.terminalFinalizationRecovery) return;
      const cleanupRunId = control.cancelledRunId || null;
      if (cleanupRunId && (
        control.runCleanupAuthorized === true
        || cleanupRunId !== priorRunId
        || control.ownsExistingRecoveryRun
      )) {
        const [runCleanup, analysisCleanup] = await Promise.all([
          window.electronAPI?.discardJobRun?.({
            canvasFilePath,
            nodeId: id,
            runId: cleanupRunId,
          }),
          window.electronAPI?.discardJobAnalysisSnapshot?.({
            canvasFilePath,
            nodeId: id,
            runId: cleanupRunId,
          }),
        ]);
        const runRetired = runCleanup?.ok === true && (
          runCleanup.cleared === true || runCleanup.absent === true || runCleanup.tokenMismatch === true
        );
        if (!runRetired || analysisCleanup?.ok !== true) {
          throw new Error('The interrupted Job Search recovery files could not be removed safely.');
        }
      }
    };
    control.cleanupArtifacts = () => {
      if (control.cleanupPromise) return control.cleanupPromise;
      const cleanupAttempt = Promise.resolve().then(performCleanupArtifacts);
      control.cleanupPromise = cleanupAttempt;
      // A successful attempt stays memoized for the remainder of this exact
      // Board child control. Only rejection releases the slot so an explicit
      // Retry can make a new acknowledgement/inspection attempt.
      void cleanupAttempt.catch(() => {
        if (control.cleanupPromise === cleanupAttempt) control.cleanupPromise = null;
      });
      return cleanupAttempt;
    };

    const [rollbackResult, cleanupResult] = await Promise.allSettled([
      control.rollbackPromise,
      control.cleanupArtifacts(),
    ]);
    const rollbackCommitted = rollbackResult.status === 'fulfilled' && rollbackResult.value === true;
    if (!rollbackCommitted && getNode(id)) {
      EventLogger.error(`[JobSearch][${id}] Board rollback was not observable before child cancellation settled`);
    }
    if (!rollbackCommitted) {
      throw boardCancellationCleanupError(null, 'The Job Search rollback was not committed to the canvas.');
    }
    if (cleanupResult.status === 'rejected') {
      throw boardCancellationCleanupError(cleanupResult.reason);
    }
    return { status: 'cancelled', cancelled: true, runId: control.cancelledRunId || activeRunId || null };
  }, [cancelCleanSourceCardDismiss, canvasFilePath, epoch, getEdges, getNode, getNodes, id, isMountedRef, moduleRunQueue, resetSourceProgress, restoreBoardSourceGraph, settleManualAiRetirement, updateGlobal]);

  // Register the source-scoped executor with the canvas coordinator. Job Board
  // owns admission and queue order; this node deliberately keeps execution so
  // every backend request, recovery sidecar, source card, and result still uses
  // the Job Search hub id that owns that data.
  const runForJobBoard = useCallback(async ({
    orchestratorNodeId,
    boardRunId,
    isCancelled,
    manualAiResume = null,
    pausedSourceContinuation = null,
    freshImportCapability = null,
    recoverInterruptedJobRun = false,
    interruptedRecoveryRunId = null,
    finalizationRecovery = null,
  } = {}) => {
    if (isJobWorkflowDeletionPending(id)) {
      return searchRunOutcome('cancelled', { error: 'This Job Search is pending deletion.' });
    }
    if (!orchestratorNodeId || !boardRunId) {
      return searchRunOutcome('failed', { error: 'Missing Job Board orchestration identity.' });
    }
    try {
      if (typeof isCancelled === 'function' && isCancelled()) {
        return searchRunOutcome('cancelled');
      }
    } catch {
      // A stale or torn-down parent predicate cannot prove this child still
      // belongs to a live Board transaction. Fail closed before reading or
      // mutating Search state.
      return searchRunOutcome('cancelled');
    }
    // The Board can wait behind an entire earlier transaction. Re-read every
    // admission field at this child's actual turn, before handleRerun clears a
    // paused/batch recovery state or any prior result metadata.
    const liveNode = getNode(id);
    const requestedFinalizationRecovery = finalizationRecovery?.kind === 'terminal-finalization'
      ? finalizationRecovery
      : null;
    const requestedManualRetirementRecovery = finalizationRecovery?.kind === 'manual-ai-retirement'
      ? finalizationRecovery
      : null;
    const liveFinalizationRecovery = liveNode?.data?.terminalFinalizationRecovery?.kind === 'terminal-finalization'
      ? liveNode.data.terminalFinalizationRecovery
      : null;
    if (
      requestedFinalizationRecovery?.runId
      && liveFinalizationRecovery?.runId
      && requestedFinalizationRecovery.runId !== liveFinalizationRecovery.runId
    ) {
      return searchRunOutcome('recovery-inspection-failed', {
        runId: requestedFinalizationRecovery.runId,
        resultDisposition: requestedFinalizationRecovery.resultDisposition || null,
        error: 'The saved Board and Job Search terminal recovery tokens no longer match.',
      });
    }
    // The Search writes the descriptor from the same terminal transaction as
    // its visible result. When the Board also carries a copy, prefer the live
    // same-run Search descriptor so an older/batched Board snapshot cannot
    // override its exact fingerprint or terminal counts.
    const effectiveFinalizationRecovery = liveFinalizationRecovery
      || requestedFinalizationRecovery;
    const effectiveManualAiResume = manualAiResume?.runId
      && liveNode?.data?.manualAiResume?.runId === manualAiResume.runId
      ? liveNode.data.manualAiResume
      : manualAiResume;
    const exactInterruptedRecovery = typeof interruptedRecoveryRunId === 'string'
      && !!interruptedRecoveryRunId;
    const recoveryOwner = manualAiResume?.runId
      ? findJobSearchBoardRecoveryOwner(id, manualAiResume.runId, getNodes(), getEdges())
      : findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges());
    const boardPlanForPausedContinuation = getNode(orchestratorNodeId)?.data?.boardScanResume || null;
    const exactPausedScoringContinuation = isExactPausedBoardScoringContinuation(
      liveNode,
      id,
      boardPlanForPausedContinuation,
      boardRunId,
      pausedSourceContinuation,
    );
    if (pausedSourceContinuation && !exactPausedScoringContinuation) {
      return searchRunOutcome('not-ready', {
        runId: pausedSourceContinuation.jobRunId || null,
        error: 'The paused Job Search continuation no longer matches its Job Board recovery plan.',
      });
    }
    // Last-line defence for Board admission. A normal `done` generation is
    // immutable Board input: the parent must combine its stored result rather
    // than reach the generic handleRerun fallback below and scrape old career
    // data again. Exact finalization/manual/paused recoveries remain above and
    // below this guard because they still own a durable transaction.
    const ordinaryDoneAdmission = classifyJobBoardSourceAdmission(liveNode);
    const ownsExactDoneRecovery = !!effectiveFinalizationRecovery
      || !!requestedManualRetirementRecovery
      || !!effectiveManualAiResume?.retirementPending
      || isSavedScrapeManualAiResume(effectiveManualAiResume)
      || exactInterruptedRecovery
      || exactPausedScoringContinuation;
    if (!ownsExactDoneRecovery && ordinaryDoneAdmission.kind === 'reuse-terminal') {
      return searchRunOutcome('completed', {
        runId: ordinaryDoneAdmission.outcome.runId,
        resultDisposition: ordinaryDoneAdmission.outcome.resultDisposition,
        reusedByJobBoard: true,
      });
    }
    if (!ownsExactDoneRecovery && ordinaryDoneAdmission.kind === 'terminal-requires-fresh-input') {
      return searchRunOutcome('not-ready', {
        runId: liveNode?.data?.jobRunId || null,
        resultDisposition: liveNode?.data?.resultDisposition || null,
        error: ordinaryDoneAdmission.reason,
      });
    }
    const notReady = boardRunReadiness(liveNode, {
      processing: processingRunsRef.current.active,
      platformsVerifying: platformsVerifyingRef.current,
      manualAiResume: effectiveManualAiResume,
      orchestratorNodeId,
      boardRunId,
      recoveryOwner,
      terminalFinalizationRecovery: !!effectiveFinalizationRecovery || !!requestedManualRetirementRecovery,
      pausedScoringContinuation: exactPausedScoringContinuation,
      interruptedRecovery: exactInterruptedRecovery,
    });
    if (notReady) return notReady;
    if (requestedManualRetirementRecovery) {
      const liveData = liveNode?.data || {};
      const exactCommittedResult = liveData.hubState === 'done'
        && liveData.jobRunId === requestedManualRetirementRecovery.runId
        && (!requestedManualRetirementRecovery.resultDisposition
          || liveData.resultDisposition === requestedManualRetirementRecovery.resultDisposition)
        && (!requestedManualRetirementRecovery.fingerprint
          || moduleFingerprint(liveData.scoredJobs) === requestedManualRetirementRecovery.fingerprint);
      if (!exactCommittedResult) {
        return searchRunOutcome('recovery-inspection-failed', {
          runId: requestedManualRetirementRecovery.runId,
          resultDisposition: requestedManualRetirementRecovery.resultDisposition || null,
          error: 'The committed Job Search result changed before manual-AI cleanup recovery settled.',
        });
      }
    }
    const liveBefore = liveNode.data || data;
    const boardPlanAtAdmission = boardPlanForPausedContinuation;
    const durableRollbackAtAdmission = boardPlanAtAdmission?.version === 1
      && boardPlanAtAdmission.boardRunId === boardRunId
      && (boardPlanAtAdmission.activeSourceId === id
        || (Array.isArray(boardPlanAtAdmission.activeSourceIds)
          && boardPlanAtAdmission.activeSourceIds.includes(id)))
      && (
        (boardPlanAtAdmission.activeSourceRollback?.version === 1
          && boardPlanAtAdmission.activeSourceRollback.sourceId === id
          && boardPlanAtAdmission.activeSourceRollback)
        || (boardPlanAtAdmission.activeSourceRollbacks?.[id]?.version === 1
          && boardPlanAtAdmission.activeSourceRollbacks[id].sourceId === id
          && boardPlanAtAdmission.activeSourceRollbacks[id])
      )
      ? (boardPlanAtAdmission.activeSourceRollback?.sourceId === id
        ? boardPlanAtAdmission.activeSourceRollback
        : boardPlanAtAdmission.activeSourceRollbacks[id])
      : null;

    const manualAiRunId = effectiveManualAiResume?.runId || createManualAiRunId(id);
    const localEpochCancelled = epoch.start();
    const control = {
      orchestratorNodeId,
      boardRunId,
      manualAiRunId,
      previousData: durableRollbackAtAdmission
        ? safeClone(durableRollbackAtAdmission.previousData || {})
        : liveBefore,
      previousSourceGraph: durableRollbackAtAdmission
        ? safeClone(durableRollbackAtAdmission.sourceGraph || { nodes: [], edges: [] })
        : captureJobSourceGraph(id, getNodes(), getEdges()),
      priorRunId: durableRollbackAtAdmission
        ? durableRollbackAtAdmission.previousData?.jobRunId || null
        : liveBefore.jobRunId || null,
      cancelled: false,
      rollbackApplied: false,
      cancelledRunId: null,
    };
    boardRunControlRef.current = control;
    const cancelled = () => localEpochCancelled()
      || control.cancelled
      || boardRunControlRef.current !== control
      || (typeof isCancelled === 'function' && isCancelled());
    const runFreshBoardImport = () => {
      const freshAdmission = jobCareerImportBoardAdmission(getNode(id)?.data, {
        capability: freshImportCapability,
        boardRunId,
        nodeId: id,
      });
      if (freshAdmission.kind === 'missing') {
        return searchRunOutcome('not-ready', {
          error: 'This Job Search was already attempted or is missing its fresh career import proof. Manually clear career data and import fresh files before starting a new Board search.',
        });
      }
      return handleRerun({
        frameSourceCards: false,
        runOrigin: 'job-board-scan',
        manualAiRunId,
        queueManagedByBoard: true,
        parentCancelled: cancelled,
        orchestratorNodeId,
        boardRunId,
        freshImportCapability,
      });
    };
    const retireOwnedManualMarker = async () => {
      const liveResume = getNode(id)?.data?.manualAiResume || null;
      const markerOwnedByThisRun = liveResume?.runId === manualAiRunId
        && (!liveResume.orchestratorNodeId || liveResume.orchestratorNodeId === orchestratorNodeId)
        && (!liveResume.boardRunId || liveResume.boardRunId === boardRunId);
      if (!markerOwnedByThisRun) return true;
      const retired = await completeManualAiRun(manualAiRunId);
      if (!retired) return false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await waitForRendererCommitFrame();
        if (getNode(id)?.data?.manualAiResume?.runId !== manualAiRunId) return true;
      }
      return getNode(id)?.data?.manualAiResume?.runId !== manualAiRunId;
    };

    EventLogger.log(`[JobSearch][${id}] Board scan requested board=${orchestratorNodeId} run=${boardRunId}`);
    try {
      let outcome;
      if (effectiveFinalizationRecovery) {
        control.ownsExistingRecoveryRun = true;
        control.terminalFinalizationRecovery = effectiveFinalizationRecovery;
        control.previousData = {
          ...control.previousData,
          terminalFinalizationRecovery: effectiveFinalizationRecovery,
        };
        control.cancelledRunId = effectiveFinalizationRecovery.runId || null;
        outcome = await retryTerminalFinalization(effectiveFinalizationRecovery, cancelled);
        if (outcome?.status === 'completed' && effectiveManualAiResume?.retirementPending) {
          const retired = await retireOwnedManualMarker();
          if (!retired) {
            outcome = searchRunOutcome('recovery-cleanup-failed', {
              runId: effectiveFinalizationRecovery.runId,
              resultDisposition: effectiveFinalizationRecovery.resultDisposition,
              terminalStatus: effectiveFinalizationRecovery.terminalStatus,
              terminalOutcome: effectiveFinalizationRecovery.terminalOutcome,
              scoreReadyCount: effectiveFinalizationRecovery.scoreReadyCount,
              fingerprint: effectiveFinalizationRecovery.fingerprint,
              manualAiRunId,
              error: getNode(id)?.data?.errorMessage || 'The saved manual-AI handoff cleanup did not finish.',
            });
          } else {
            updateGlobal(id, { errorMessage: null });
          }
        }
      } else if (effectiveManualAiResume?.retirementPending) {
        // A completed child can fail only while retiring its exact manual-AI
        // handoff. Re-enter that housekeeping step without rerunning providers,
        // then hand the already-committed result back to the Board.
        control.ownsExistingRecoveryRun = true;
        control.cancelledRunId = liveNode?.data?.jobRunId || null;
        const retired = await retireOwnedManualMarker();
        const terminalData = getNode(id)?.data || liveNode?.data || {};
        if (!retired) {
          outcome = searchRunOutcome('recovery-cleanup-failed', {
            runId: terminalData.jobRunId || null,
            resultDisposition: terminalData.resultDisposition || null,
            terminalStatus: terminalData.resultDisposition === 'incomplete' ? 'failed' : 'completed',
            terminalOutcome: terminalData.resultDisposition === 'empty-complete'
              ? 'zero'
              : terminalData.resultDisposition === 'scored'
                ? 'populated'
                : terminalData.resultDisposition,
            scoreReadyCount: Array.isArray(terminalData.scoredJobs) ? terminalData.scoredJobs.length : null,
            fingerprint: moduleFingerprint(terminalData.scoredJobs),
            manualAiRunId,
            error: terminalData.errorMessage || 'The saved manual-AI handoff cleanup did not finish.',
          });
        } else {
          updateGlobal(id, { errorMessage: null });
          outcome = searchRunOutcome('completed', {
            runId: terminalData.jobRunId || null,
            resultDisposition: terminalData.resultDisposition || null,
          });
        }
      } else if (requestedManualRetirementRecovery) {
        // The exact handoff may already have been retired immediately before a
        // renderer crash. Its Board receipt still proves which committed Search
        // generation was awaiting acknowledgement, so continue from that result
        // without probing for a now-finalized ledger or starting a fresh search.
        outcome = searchRunOutcome('completed', {
          runId: requestedManualRetirementRecovery.runId,
          resultDisposition: requestedManualRetirementRecovery.resultDisposition,
        });
      } else if (exactPausedScoringContinuation) {
        control.ownsExistingRecoveryRun = true;
        control.cancelledRunId = pausedSourceContinuation.jobRunId;
        if (pausedSourceContinuation.mode === 'finish-paused-scoring') {
          // The clean paused state still carries its in-canvas pending rows;
          // complete those rows inside the Board-owned lane without asking any
          // provider to start a replacement search.
          outcome = await resumeScoringRef.current?.({ queueManagedExternally: true });
        } else {
          // Save sanitization removed the in-memory rows while a post-resolution
          // scorer was in flight. Re-open only the exact staged ledger recorded
          // by the Board. Unlike generic interrupted-search recovery, a missing
          // sidecar is an inspection failure—not permission to run fresh.
          outcome = await resumeInterruptedRunRef.current?.({
            discoverForBoard: true,
            expectedRunId: pausedSourceContinuation.jobRunId,
            queueManagedByBoard: true,
            parentCancelled: cancelled,
            orchestratorNodeId,
            boardRunId,
            manualAiRunId,
            onDiscoveredRun: (discovered) => {
              control.ownsExistingRecoveryRun = true;
              control.cancelledRunId = discovered?.runId || pausedSourceContinuation.jobRunId;
            },
          });
          if (outcome?.status === 'not-found') {
            outcome = searchRunOutcome('recovery-inspection-failed', {
              runId: pausedSourceContinuation.jobRunId,
              error: 'The staged post-resolution Job Search run was not found. It was kept unchanged; retry or cancel this Job Board run.',
            });
          }
        }
      } else if (isSavedScrapeManualAiResume(effectiveManualAiResume)) {
        control.ownsExistingRecoveryRun = true;
        outcome = await resumeSavedScrapeRef.current?.({
            manualAiRunId,
            recoveryMode: effectiveManualAiResume.recoveryMode,
            queueManagedByBoard: true,
            parentCancelled: cancelled,
            orchestratorNodeId,
          });
      } else if (exactInterruptedRecovery) {
        // `expectedRunId` makes a vanished or replaced preflight manifest an
        // inspection failure. It must never fall through into handleRerun.
        outcome = await resumeInterruptedRunRef.current?.({
          discoverForBoard: true,
          expectedRunId: interruptedRecoveryRunId,
          queueManagedByBoard: true,
          parentCancelled: cancelled,
          orchestratorNodeId,
          boardRunId,
          manualAiRunId,
          onDiscoveredRun: (discovered) => {
            control.ownsExistingRecoveryRun = true;
            control.cancelledRunId = discovered?.runId || interruptedRecoveryRunId;
          },
        });
        if (outcome?.status === 'not-found' || outcome?.status === 'stale-recovery-found') {
          outcome = searchRunOutcome('recovery-inspection-failed', {
            runId: interruptedRecoveryRunId,
            error: 'The interrupted Job Search recovery changed before the Job Board could resume it.',
          });
        }
      } else if (recoverInterruptedJobRun || window.electronAPI?.peekJobRun) {
        outcome = await resumeInterruptedRunRef.current?.({
          discoverForBoard: true,
          queueManagedByBoard: true,
          parentCancelled: cancelled,
          orchestratorNodeId,
          boardRunId,
          manualAiRunId,
          onDiscoveredRun: (discovered) => {
            control.ownsExistingRecoveryRun = true;
            control.cancelledRunId = discovered?.runId || null;
          },
        });
        if (outcome?.status === 'stale-recovery-found') {
          const staleRunId = outcome.runId || null;
          control.ownsExistingRecoveryRun = true;
          control.cancelledRunId = staleRunId;
          const cleanup = staleRunId
            ? await window.electronAPI?.discardJobRun?.({ canvasFilePath, nodeId: id, runId: staleRunId })
            : null;
          if (cancelled()) return searchRunOutcome('cancelled', { runId: staleRunId });
          const retired = cleanup?.ok === true && (cleanup.cleared === true || cleanup.absent === true);
          if (!retired) {
            outcome = searchRunOutcome('recovery-inspection-failed', {
              runId: staleRunId,
              error: 'The expired Job Search recovery files could not be cleared safely.',
            });
          } else {
            setResumeOffer(current => current?.runId === staleRunId ? null : current);
            outcome = searchRunOutcome('not-found');
          }
        }
        // A crash can land before the backend creates its run ledger. With no
        // exact resumable token there is nothing to preserve; only then is a
        // fresh retry safe. Inspection failures remain failures so a temporary
        // disk/IPC problem can never truncate recoverable staged pages.
        if (outcome?.status === 'not-found') {
          outcome = await runFreshBoardImport();
        }
      } else {
        // The ordinary Board path can only begin a newly imported capability.
        // Exact paused/manifest/manual recovery branches above retain their
        // own existing-generation inputs and never arrive here.
        outcome = await runFreshBoardImport();
      }

      if (cancelled()) {
        // Even when a card/dialog already initiated rollback, await that exact
        // receipt before resolving the child. The Board must not release its
        // queue lease while source nodes/edges are still being reconciled.
        const cancellation = await cancelBoardRun({
          orchestratorNodeId,
          boardRunId,
          reason: 'job-board-cancelled',
        });
        return searchRunOutcome('cancelled', {
          runId: cancellation?.runId || outcome?.runId || control.cancelledRunId,
        });
      }
      if (isJobBoardUserCancellation(outcome)) {
        const cancellation = await cancelBoardRun({
          orchestratorNodeId,
          boardRunId,
          reason: 'manual-ai-cancelled',
        });
        return searchRunOutcome('cancelled', { runId: cancellation?.runId || outcome?.runId });
      }
      // The parent still owns the shared lease, but React may batch the child's
      // paused/failed state until this async call yields. Make every outcome
      // observable before the Board classifies it or advances to the next
      // Search; completed outcomes receive the stricter exact-token check below.
      await waitForRendererCommitFrame();
      if (outcome?.status === 'recovery-finalization-failed') {
        // Terminal result + descriptor are separate React writes. Do not let
        // the Board snapshot the previous generation while either write is
        // still batched; return only an exact, observable descriptor.
        return waitForCommittedSearchOutcome({
          getNode,
          nodeId: id,
          outcome,
          cancelled,
        });
      }
      if (
        outcome?.status === 'recovery-inspection-failed'
        || outcome?.status === 'recovery-cleanup-failed'
      ) {
        // A temporary disk/IPC failure is not evidence that the exact saved
        // scrape disappeared. Preserve both the child's manual marker and the
        // Board plan so the explicit recovery Retry can inspect the same run.
        return outcome;
      }
      if (!outcome || outcome.status !== 'completed') {
        // A provider/scoring failure can happen after the manual dialog has
        // published its durable marker. The Board records this child as
        // incomplete and retires its plan, so leaving the exact marker behind
        // would create an ownerless recovery that neither standalone Search
        // nor a future Board is allowed to adopt. Retire only this run's marker;
        // a newer handoff on the same Search is left untouched.
        await retireOwnedManualMarker();
        return outcome || searchRunOutcome('failed', {
          error: 'The search did not return a terminal result.',
        });
      }

      // updateGlobal is a React state write. Do not release the Board-owned
      // queue turn until the exact terminal run/disposition is observable in
      // React Flow; otherwise the Board's immediate live combine snapshot can
      // still see the previous source result.
      const committed = await waitForCommittedSearchOutcome({
        getNode,
        nodeId: id,
        outcome,
        cancelled,
      });
      if (committed.status === 'cancelled') {
        const cancellation = await cancelBoardRun({
          orchestratorNodeId,
          boardRunId,
          reason: 'job-board-cancelled',
        });
        return searchRunOutcome('cancelled', {
          runId: cancellation?.runId || committed.runId || control.cancelledRunId,
        });
      }
      return committed;
    } catch (error) {
      // Rejections must obey the same ownership cleanup as returned failures.
      // In particular, a failed snapshot/ledger IPC can reject before the
      // child runner reaches its normal outcome block; leaving its marker
      // behind after the Board retires the plan creates an unrecoverable orphan.
      if (cancelled() || isJobBoardUserCancellation(error)) {
        const cancellation = await cancelBoardRun({
          orchestratorNodeId,
          boardRunId,
          reason: isJobBoardUserCancellation(error)
            ? 'manual-ai-cancelled'
            : 'job-board-cancelled',
        });
        return searchRunOutcome('cancelled', {
          runId: cancellation?.runId || control.cancelledRunId,
        });
      }
      await retireOwnedManualMarker();
      throw error;
    } finally {
      if (boardRunControlRef.current === control) boardRunControlRef.current = null;
    }
  }, [cancelBoardRun, canvasFilePath, completeManualAiRun, data, epoch, getEdges, getNode, getNodes, handleRerun, id, retryTerminalFinalization, updateGlobal]);

  useEffect(() => {
    cancelBoardRunRef.current = cancelBoardRun;
    return () => {
      if (cancelBoardRunRef.current === cancelBoardRun) cancelBoardRunRef.current = null;
    };
  }, [cancelBoardRun]);

  useEffect(
    () => jobSearchCoordinator.registerSearchModule(id, runForJobBoard, cancelBoardRun),
    [cancelBoardRun, id, jobSearchCoordinator, runForJobBoard],
  );

  // Re-score the currently displayed listings without invoking any search,
  // scrape, seen-history, or job-run lifecycle work. This is deliberately
  // separate from Re-run Search: existing listings are often history-filtered
  // on a fresh scrape and therefore cannot be safely revisited that way.
  const handleReanalyze = useCallback(async () => {
    if (isJobWorkflowDeletionPending(id)) return;
    if (data.locked || processingRunsRef.current.active || localQueueAdmissionRef.current) return;
    if (hasPendingManualAiRetirement(getNode(id)?.data || data)) {
      addToast({
        title: 'Finish Job Search Cleanup First',
        description: 'Retry the older manual-AI cancellation cleanup before re-evaluating saved jobs.',
        type: 'info',
      });
      return;
    }
    if (getNode(id)?.data?.terminalFinalizationRecovery) {
      addToast({
        title: 'Finish Job Search Recovery First',
        description: 'Retry the saved terminal cleanup before changing these scored results.',
        type: 'info',
      });
      return;
    }

    if (deferDirectSearchToBoard('Saved-job re-evaluation')) return;

    const requestedRecoveryOwner = findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges());
    if (requestedRecoveryOwner) {
      addToast({
        title: 'Job Board Recovery in Progress',
        description: 'This search is reserved by an interrupted Job Board run. Cancel or finish that Board before re-evaluating these jobs.',
        type: 'info',
      });
      return;
    }

    const requestedData = safeClone(getNode(id)?.data || data);
    const requestedFingerprint = reanalysisInputFingerprint(requestedData);
    const existingScoredJobs = Array.isArray(requestedData.scoredJobs) ? requestedData.scoredJobs : [];
    // The pool must be a SUPERSET of what the hub is displaying, never an
    // alternative to it. `finishScoringAndSpawn` below REPLACES `scoredJobs`
    // with whatever this analyses, so any path that leaves the pool holding a
    // subset — a late append that evaluated only its new rows, preferences
    // switched on after a run — turned "Re-evaluate Saved Jobs" into a silent
    // delete of every result outside that subset. Union instead of choosing:
    // pool entries come first so their preference-audit enrichment survives
    // dedup, and results absent from the pool are added back.
    const savedPool = Array.isArray(requestedData.preferenceCandidatePool) ? requestedData.preferenceCandidatePool : [];
    const savedCandidatePool = savedPool.length > 0
      ? dedupJobsAcrossSources([...savedPool, ...existingScoredJobs])
      : existingScoredJobs;
    if (savedCandidatePool.length === 0) {
      addToast({
        title: 'No Saved Jobs to Re-analyze',
        description: 'Run a job search first, then this action can update its hiring-fit assessments.',
        type: 'info',
      });
      return;
    }
    if (!requestedData.resumeProfile) {
      addToast({
        title: 'Career Profile Needed',
        description: 'The saved career profile is unavailable, so these jobs cannot be re-analyzed.',
        type: 'error',
      });
      return;
    }

    // A saved result is both a listing and the last scoring pass over it. Send
    // only the former back: a per-job scorer fallback spreads its input into a
    // placeholder, so retaining matchScore, reasoning, careerDirection,
    // requirementAssessments, materialGaps, strengths, experienceAssessment,
    // confidence, fitAssessment, rawScore, adjustedScore, adjustments, or
    // calibration would make that placeholder look like the old assessment.
    // Listing and compensation evidence intentionally remain intact.
    const jobsToReanalyze = savedCandidatePool.map(job => {
      const listing = { ...(job || {}) };
      [
        'matchScore', 'reasoning', 'careerDirection', 'requirementAssessments',
        'materialGaps', 'strengths', 'experienceAssessment', 'confidence',
        'fitAssessment', 'rawScore', 'adjustedScore', 'adjustments', 'calibration',
        'preferenceAssessment',
      ].forEach(field => delete listing[field]);
      return listing;
    });
    const admissionToken = Symbol(`reanalyze-saved-jobs:${id}`);
    localQueueAdmissionRef.current = admissionToken;
    let processingToken = null;
    const currentId = id;
    const manualAiRunId = createManualAiRunId(currentId);
    const cancelled = epoch.start();
    let runData = requestedData;
    let restorePatch = null;
    let lease = null;

    try {
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: currentId,
        kind: 'jobsearch',
        lane: 'job-search',
        label: 'Re-evaluate saved jobs',
        onQueued: ({ position }) => {
          updateGlobal(currentId, {
            queuedModuleRun: { label: 'Re-evaluating saved jobs', position },
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(currentId, { queuedModuleRun: { label: 'Re-evaluating saved jobs', position } });
        },
        onStart: () => {
          if (cancelled() || isJobWorkflowDeletionPending(currentId)) throw new Error('Node deleted');
          updateGlobal(currentId, { queuedModuleRun: null });
        },
      });

      runData = getNode(currentId)?.data || requestedData;
      if (
        cancelled()
        || isJobWorkflowDeletionPending(currentId)
        || !getNode(currentId)
      ) return;
      if (runData.locked) {
        addToast({
          title: 'Job Search Locked',
          description: 'This search was locked while re-evaluation was queued. Unlock it and try again.',
          type: 'info',
        });
        return;
      }
      if (
        hasPendingManualAiRetirement(runData)
        || runData.terminalFinalizationRecovery
      ) {
        addToast({
          title: 'Finish Job Search Recovery First',
          description: 'Saved cleanup claimed this search while re-evaluation was queued. Finish it and try again.',
          type: 'info',
        });
        return;
      }
      if (isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())) {
        updateGlobal(currentId, { queuedModuleRun: null });
        addToast({
          title: 'Run from Job Board',
          description: 'This search became Board-managed while re-evaluation was queued. Use the connected Job Board.',
          type: 'info',
        });
        return;
      }
      const liveRecoveryOwner = findJobSearchBoardActiveRecoveryOwner(
        currentId,
        getNodes(),
        getEdges(),
      );
      if (liveRecoveryOwner) {
        updateGlobal(currentId, { queuedModuleRun: null });
        addToast({
          title: 'Job Board Recovery in Progress',
          description: 'The interrupted Job Board claimed this search while re-evaluation was queued. Finish or cancel that Board, then try again.',
          type: 'info',
        });
        return;
      }
      if (reanalysisInputFingerprint(runData) !== requestedFingerprint) {
        updateGlobal(currentId, { queuedModuleRun: null });
        addToast({
          title: 'Saved Jobs Changed',
          description: 'The search results or settings changed while re-evaluation was queued. Review them and try again.',
          type: 'info',
        });
        return;
      }
      processingToken = processingRunsRef.current.start();
      if (!processingToken) return;
      restorePatch = reanalysisRestorePatch(runData);
      reanalysisRestoreRef.current = { token: processingToken, patch: restorePatch };
      activeManualAiRunIdRef.current = manualAiRunId;
      updateGlobal(currentId, {
        errorMessage: null,
        rerunOutcome: null,
        rerunNotice: null,
      });

      const locationSnapshot = runData.locationSnapshot || {
        searchLocation: getSearchLocation({
          searchLocation: runData.searchLocation,
          preferredLocation: runData.preferredLocation,
          canonicalLocation: runData.canonicalLocation,
        }),
        remoteResidences: normalizeRemoteResidences(runData.remoteResidences),
      };
      const activeTargetRole = (runData.targetRole || '').trim();
      const activeJobPreferences = String(runData.jobPreferences || '').trim();
      // ROLE LOCKING: re-evaluating saved jobs is still a "scan" of this hub's
      // locked brief, so it must cost zero interpretation calls once locked —
      // reuse the durable plan exactly like a fresh search run does. Only a
      // hub that never locked (legacy canvas, brief written but never run
      // under role locking) falls back to a fresh single-pass interpretation.
      // FIX 2: hasResolvedRoleLock (resolvedRolesMeta), not resolvedRoles.length
      // — a legitimate zero-title lock must still skip re-interpretation.
      let jobPreferencesInterpretation = (
        hasResolvedRoleLock(runData) && runData.searchBriefPlan
      ) ? runData.searchBriefPlan : null;
      if (activeJobPreferences && !jobPreferencesInterpretation && window.electronAPI?.interpretJobPreferences) {
        updateGlobal(currentId, { hubState: 'interpreting-preferences' });
        const interpretationResult = await window.electronAPI.interpretJobPreferences({
          profile: runData.resumeProfile,
          careerData: runData.careerData,
          nodeId: currentId,
          manualAiRunId,
          targetRole: activeTargetRole,
          jobPreferences: activeJobPreferences,
          searchLocation: locationSnapshot.searchLocation,
          remoteResidences: locationSnapshot.remoteResidences,
        });
        if (cancelled()) return;
        if (interpretationResult?.success === false) throw new Error(interpretationResult.error || 'Failed to understand Job Preferences');
        jobPreferencesInterpretation = interpretationResult?.preferencePlan
          ?? interpretationResult?.jobPreferencePlan
          ?? interpretationResult?.jobPreferencesInterpretation
          ?? interpretationResult?.interpretation
          ?? null;
      }
      updateGlobal(currentId, {
        activeJobPreferences,
        jobPreferencePlan: jobPreferencesInterpretation,
        jobPreferencesInterpretation,
      });
      const preferenceResult = await evaluatePreferencesForRun({
        jobs: jobsToReanalyze,
        profile: runData.resumeProfile,
        careerData: runData.careerData,
        activeTargetRole,
        activeJobPreferences,
        jobPreferencesInterpretation,
        locationSnapshot,
        manualAiRunId,
      });
      if (cancelled()) return;
      if (preferenceResult.jobs.length === 0) {
        await finishScoringAndSpawn({
          scoredJobs: [],
          gatheredCount: runData.gatheredCount,
          // `scrapedCount` is the score-ready stage of the current funnel.
          // Keep the original found total, but an all-filtered re-evaluation
          // has zero current score-ready jobs.
          scrapedCount: 0,
          scrapeWarnings: Array.isArray(runData.scrapeWarnings) ? runData.scrapeWarnings : [],
          // Re-evaluation only changes the score pass. Keep collection facts
          // from the completed search rather than clearing its source caveats.
          collectionScopeCaveats: collectionScopeCaveatsForSavedJobReanalysis(runData),
          preferenceMatchedCount: preferenceResult.matchedCount,
          preferenceFilteredCount: preferenceResult.filteredCount,
          preferenceEvaluation: preferenceResult.evaluation,
          preferenceCandidatePool: preferenceResult.candidatePool,
          resultDisposition: 'preference-filtered',
          cancelled,
          completeRun: false,
        });
        if (cancelled()) return;
        await completeManualAiRun(manualAiRunId);
        return;
      }
      setScoringProgress(null);
      updateGlobal(currentId, { hubState: 'scoring', jobCount: preferenceResult.jobs.length });
      const scoreResult = await window.electronAPI.scoreJobs({
        jobs: preferenceResult.jobs,
        profile: runData.resumeProfile,
        careerData: runData.careerData,
        nodeId: currentId,
        manualAiRunId,
        targetRole: activeTargetRole,
        jobPreferences: activeJobPreferences,
        jobPreferencePlan: jobPreferencesInterpretation,
        preferencePlan: jobPreferencesInterpretation,
        preferenceEvaluation: preferenceResult.evaluation,
        preferenceCandidatePool: preferenceResult.candidatePool,
        searchLocation: locationSnapshot.searchLocation,
        remoteResidences: locationSnapshot.remoteResidences,
        snapshotContext: {
          sourceHubId: currentId,
          canvasFilePath,
          resumeSummary: buildResumeSummary(runData.resumeProfile),
          sourceGatheredCount: runData.gatheredCount ?? jobsToReanalyze.length,
          jobPreferences: activeJobPreferences,
          jobPreferencePlan: jobPreferencesInterpretation,
          preferenceCandidatePool: preferenceResult.candidatePool,
          searchLocation: locationSnapshot.searchLocation,
          remoteResidences: locationSnapshot.remoteResidences,
        },
      });
      if (cancelled()) return;
      if (!scoreResult.success) {
        throw new Error(scoreResult.error || 'Failed to re-analyze hiring fit');
      }

      await finishScoringAndSpawn({
        scoredJobs: scoreResult.scoredJobs,
        gatheredCount: runData.gatheredCount,
        // Re-analysis does not collect anything, so gatheredCount remains the
        // original source-found total. The score-ready stage is recomputed
        // from the current preferences, not retained from an older filter.
        scrapedCount: preferenceResult.jobs.length,
        scrapeWarnings: Array.isArray(runData.scrapeWarnings) ? runData.scrapeWarnings : [],
        // Re-evaluation does not re-collect listings, so its successful
        // terminal receipt must retain the original collection disclosure.
        collectionScopeCaveats: collectionScopeCaveatsForSavedJobReanalysis(runData),
        aiSkipped: !!scoreResult.aiSkipped,
        collectionOnly: !!scoreResult.collectionOnly,
        testMode: !!scoreResult.testMode,
        preferenceMatchedCount: scoreResult.preferenceMatchedCount ?? preferenceResult.matchedCount,
        preferenceFilteredCount: scoreResult.preferenceFilteredCount ?? preferenceResult.filteredCount,
        preferenceEvaluation: scoreResult.preferenceEvaluation ?? preferenceResult.evaluation,
        preferenceCandidatePool: scoreResult.preferenceCandidatePool ?? preferenceResult.candidatePool,
        cancelled,
        // This score-only action has no search run or history lifecycle.
        completeRun: false,
      });
      if (cancelled()) return;
      // The retry produced a new terminal receipt.  Its prior non-blocking
      // failure notice must not survive a successful saved-job re-analysis.
      updateGlobal(currentId, { reanalysisNotice: null });
      await completeManualAiRun(manualAiRunId);

      if (!cancelled()) {
        addToast({
          title: 'Saved Jobs Re-evaluated',
          description: `Updated your preferences and hiring-fit assessments for ${savedCandidatePool.length} saved job${savedCandidatePool.length === 1 ? '' : 's'}.`,
          type: 'success',
        });
      }
    } catch (error) {
      if (cancelled()) return;
      if (isNodeDeletedAbort(error)) {
        // React Flow now awaits acknowledged cleanup before committing a node
        // deletion. If a later durable step rejects that deletion, leave this
        // still-mounted hub on its exact pre-analysis result instead of a
        // renderer-only scoring state whose worker was just aborted.
        if (restorePatch && getNode(currentId)) {
          updateGlobal(currentId, {
            hubState: 'done',
            queuedModuleRun: null,
            ...restorePatch,
          });
        }
        return;
      }
      await completeManualAiRun(manualAiRunId);
      EventLogger.error('[JobSearch] Saved-job hiring-fit re-analysis failed:', error);
      // No mutation of scoredJobs occurs until finishScoringAndSpawn succeeds.
      // Restore all summary fields explicitly as a defense against a queued or
      // partial scorer transition, and make the failure actionable in the hub.
      const liveRestorePatch = restorePatch || reanalysisRestorePatch(runData);
      updateGlobal(currentId, {
        hubState: 'done',
        queuedModuleRun: null,
        ...liveRestorePatch,
        // The exact prior terminal rows were restored. Keep the failure
        // visible without using the generic terminal-error state, which would
        // make a valid Board input look incomplete and route Retry into a
        // destructive fresh search.
        errorMessage: null,
        reanalysisNotice: error?.message || String(error),
      });
      addToast({
        title: 'Saved Job Re-evaluation Failed',
        description: 'Your existing scores were kept. Try again when the AI handoff is available.',
        type: 'error',
      });
    } finally {
      if (getNode(currentId)) {
        updateGlobal(currentId, (node) => (
          node?.data?.queuedModuleRun?.label === 'Re-evaluating saved jobs'
            ? { queuedModuleRun: null }
            : null
        ));
      }
      if (processingToken && reanalysisRestoreRef.current?.token === processingToken) {
        reanalysisRestoreRef.current = null;
      }
      if (activeManualAiRunIdRef.current === manualAiRunId) activeManualAiRunIdRef.current = null;
      if (processingToken && isMountedRef.current) processingRunsRef.current.finish(processingToken);
      if (localQueueAdmissionRef.current === admissionToken) {
        localQueueAdmissionRef.current = null;
      }
      if (lease) await waitForRendererCommitFrame();
      lease?.release();
    }
  }, [data, id, addToast, deferDirectSearchToBoard, epoch, getEdges, getNode, getNodes, moduleRunQueue, updateGlobal, canvasFilePath, finishScoringAndSpawn, isMountedRef, completeManualAiRun, evaluatePreferencesForRun]);

  // Drop the hub's career identity (files + everything derived from them) while
  // keeping every search setting, so the user can drop FRESH career files onto
  // the SAME node instead of rebuilding a module from scratch.
  const handleClearCareerFiles = useCallback((e) => {
    e?.stopPropagation();
    // A lock may have landed after this callback's render closure was created.
    // Read the live node before any cancellation, queue, IPC, or data mutation
    // so Clear cannot remove career identity from a newly locked module.
    const liveNode = getNode(id);
    // A delete can remove this node between the rendered Clear control and its
    // click handler. With no live owner, do not issue cancellation/sidecar
    // cleanup requests against an id that might already be gone or reused.
    if (!liveNode) return;
    const liveData = liveNode.data || data;
    if (liveData.locked) return;
    const durableBoardOwner = findJobSearchBoardActiveRecoveryOwner(
      id,
      getNodes(),
      getEdges(),
    );
    if (
      boardRunControlRef.current
      || durableBoardOwner
      || liveData.terminalFinalizationRecovery
      || liveData.manualAiResume?.retirementPending
      || hasCancellationPendingManualAiCleanup(liveData)
    ) {
      EventLogger.log(`[JobSearch][${id}] Clear career files rejected: durable search transaction owns this module`);
      addToast({
        title: 'Finish or cancel the active search',
        description: durableBoardOwner
          ? 'Cancel the owning Job Board run before clearing this module.'
          : 'Finish or retry the saved search cleanup before clearing career files.',
        type: 'info',
      });
      return;
    }
    // Never a silent no-op: during the drop→preflight window this button is
    // still on screen, and clearing mid-run would race the pipeline it is
    // trying to unwind. Say so rather than swallowing the click.
    if (PROCESSING_STATES.includes(hubStateRef.current) || processingRunsRef.current.active) {
      EventLogger.log(`[JobSearch][${id}] Clear career files rejected: run in progress (${hubStateRef.current})`);
      addToast({
        title: 'Search Starting',
        description: 'A run is starting or in progress — cancel it first, then clear career files.',
        type: 'info',
      });
      return;
    }

    EventLogger.log(`[JobSearch][${id}] User cleared career files`);

    // Same cancel quartet as resetHandler: a late-settling parse can otherwise
    // write the old profile straight back onto the cleared hub.
    epoch.bump();
    moduleRunQueue.cancelQueuedRunsForNode(id);
    window.electronAPI?.cancelNodeTask?.(id, 'career-files-cleared');

    // A freshly mounted, otherwise-empty hub has no persisted `jobRunId`, but
    // `peekJobRun` may already have found its OWN unfinished manifest. Treat
    // that offer as a final fallback so Clear career files also deletes the
    // scoped staging sidecar. Never borrow an owner-unknown or another hub's
    // asynchronous offer: those require their dedicated discard path.
    const ownedResumeOfferRunId = resumeOffer?.nodeId === id
      ? (resumeOffer.runId || null)
      : null;
    const runId = jobRunIdRef.current || liveData.jobRunId || ownedResumeOfferRunId || null;
    const priorClearAt = normalizeJobAnalysisClearWatermark(liveData.jobAnalysisClearedAt);
    // Date.now() is millisecond-granular. Advance beyond a prior clear even
    // when two explicit clears land in one millisecond, so each persisted run
    // token has an unambiguous boundary after a restart.
    const jobAnalysisClearedAt = nextJobAnalysisClearWatermark(priorClearAt);
    // Update synchronously so an already in-flight recovery peek cannot expose
    // a manifest from the career identity the person has just cleared.
    careerClearWatermarkRef.current = jobAnalysisClearedAt;
    const jobAnalysisClearedRunId = normalizeJobAnalysisClearRunId(runId);
    const cleanupPromises = [];
    if (runId) {
      if (window.electronAPI?.discardJobRun) {
        cleanupPromises.push({
          kind: 'run',
          promise: Promise.resolve().then(() => window.electronAPI.discardJobRun({ canvasFilePath, nodeId: id, runId })),
        });
      } else {
        cleanupPromises.push({ kind: 'run', promise: Promise.reject(new Error('Job run cleanup is unavailable')) });
      }
    }
    if (window.electronAPI?.discardJobAnalysisSnapshot) {
      cleanupPromises.push({
        kind: 'analysis',
        promise: Promise.resolve().then(() => window.electronAPI.discardJobAnalysisSnapshot({ canvasFilePath, nodeId: id, runId: jobAnalysisClearedRunId, clearedAt: jobAnalysisClearedAt })),
      });
    } else {
      cleanupPromises.push({ kind: 'analysis', promise: Promise.reject(new Error('Saved job analysis cleanup is unavailable')) });
    }
    // This node asks peekJobRun for its own scoped ledger. Keep the run-token
    // equality guard anyway: a legacy owner-unknown offer or a late refresh
    // must never let this clear hide an unrelated recovery banner.
    if (runId && resumeOffer?.runId === runId) setResumeOffer(null);

    // initialDropAcceptedRef is latched true by the identity effect and never
    // reset by data changes — without this, every drop path reopens visually but
    // acceptCareerFiles still bounces the drop.
    initialDropAcceptedRef.current = false;
    lastDroppedPathsRef.current = null;
    pendingJobsRef.current = null;
    gatheredCountRef.current = 0;
    scrapeWarningsRef.current = [];
    sourceWarningOverridesDuringSearchRef.current.clear();
    jobRunIdRef.current = null;
    hubStateRef.current = 'empty';
    // Hide recovery affordances synchronously, before any async sidecar delete
    // settles or a stale metadata fetch gets a chance to paint one.
    setSavedAnalysisMeta(null);
    updateGlobal(id, {
      hubState: 'empty', queuedModuleRun: null, errorMessage: null, rerunOutcome: null, rerunNotice: null, reanalysisNotice: null, testModeNote: null,      scoredJobs: null, finalSourceCounts: {}, resultCount: 0, totalScoredCount: 0, scrapedCount: 0, gatheredCount: 0, scoreThreshold: 0, jobRunId: null,
      jobCount: null, scoreRangeMin: null, scoreRangeMax: null,
      aiSkipped: false, collectionOnly: false, testMode: false,
      resultDisposition: null,
      activeTargetRole: null,
      pinnedTitles: null,
      // ROLE LOCKING: Clear career files is the canonical unlock — the whole
      // reason the brief is safe to freeze read-only (see the Search Brief
      // render in both states) is that clearing career data is the one
      // guaranteed way back to an editable brief. Must ship in the SAME
      // update as the career-data wipe above, never separately.
      searchBriefPlan: null, resolvedRoles: null, resolvedRolesMeta: null,
      pendingJobs: null, pendingTargetRole: null, scrapeWarnings: [], dragHover: null,
      collectionScopeCaveats: [],
      ...buildJobHubCareerClearPatch({ jobAnalysisClearedAt, jobAnalysisClearedRunId }),
      manualAiResume: null,
      _boardRollbackSourceProgressFence: null,
    });
    cancelCleanSourceCardDismiss();
    resetSourceProgress();
    cleanupAllJobChildren();
    processingRunsRef.current.cancel();
    void Promise.allSettled(cleanupPromises.map(entry => entry.promise)).then(settled => {
      const cleanup = settled.map((entry, index) => ({ kind: cleanupPromises[index].kind, ...entry }));
      if (careerFilesCleanupNeedsWarning(cleanup)) {
        EventLogger.error(`[JobSearch][${id}] Career file cleanup could not fully remove recovery data`, cleanup);
        addToast({
          title: 'Career Files Cleared with a Warning',
          description: 'The hub was cleared, but old recovery data could not be fully removed.',
          type: 'error',
        });
      } else {
        addToast({ title: 'Career Files Cleared', description: 'Search settings kept — drop fresh career files to run again.', type: 'info' });
      }
    });
  }, [data, id, canvasFilePath, resumeOffer, epoch, moduleRunQueue, updateGlobal, cancelCleanSourceCardDismiss, resetSourceProgress, cleanupAllJobChildren, addToast, getNode, getNodes, getEdges]);

  const isProcessing = PROCESSING_STATES.includes(hubState);
  // Several safe, non-destructive actions (saved scrape, re-analysis, late
  // USAJobs refresh) wait in the shared lane while the hub remains `done` or
  // `empty`. Their admission guard already blocks duplicate handlers, but the
  // visible controls must freeze too: editing the queued request's settings or
  // clearing its files would otherwise make the eventual live-turn validation
  // silently reject work the UI still claimed was queued.
  const cleanupRetirementPending = hasPendingManualAiRetirement(data);
  const controlsLocked = !!data.locked || !!data.queuedModuleRun || cleanupRetirementPending;
  // Why a drop would bounce right now, in the same order dropsBlocked ORs its
  // three inputs, so the chip names the reason that actually wins. Without it a
  // Finder drag over a blocked hub shows nothing at all — the file-drag lane
  // carries no verdict of its own the way the canvas-node lane's dragHover does.
  const dropBlockedLabel = platformsVerifying
    ? 'Checking connections…'
    : getHubDropRejectLabel({ type: 'jobhub', data })
      || (data.queuedModuleRun ? 'Queued' : null)
      || (controlsLocked ? 'Busy' : null);
  const errorControlsLocked = !!data.locked || !!data.queuedModuleRun;
  // SETTINGS LOCKING: PERMANENT freeze of every user-configurable setting
  // (Search Brief, location, remote residences, look-back window, jobs/pages
  // depth, and enabled platforms) once roles have been resolved — distinct
  // from controlsLocked/errorControlsLocked above (those mean "busy right
  // now": a queued run, a hub lock, cleanup pending — and clear on their
  // own). settingsFrozen only ever clears via Clear career files or a
  // career-data-wiping Reset (see roleLockClearPatch / handleClearCareerFiles)
  // — never on a timer, a completed run, or an unlock toggle. Do NOT merge
  // these two concepts: a future "busy OR frozen" collapse would silently
  // let a transient unlock (e.g. a queued run finishing) re-open settings
  // that must stay fixed until a full reset, breaking re-scan reproducibility.
  const resolvedRoles = Array.isArray(data.resolvedRoles) ? data.resolvedRoles : [];
  // FIX 2: hasResolvedRoleLock (resolvedRolesMeta), not resolvedRoles.length —
  // a legitimate zero-title resolution still locked this hub and must freeze
  // settings, or a hub whose brief genuinely resolves to no titles would leave
  // every setting editable forever and re-run the resolver on every scan.
  const settingsFrozen = hasResolvedRoleLock(data);

  // Compute running total from per-source progress
  const totalSourceJobs = Object.values(sourceProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  useEffect(() => {
    // A manual-AI scoring handoff is intentionally process-local. Its durable
    // scrape snapshot is not: after a quit, offer it back only to the exact
    // hub/canvas that wrote it, never a different module sharing this canvas.
    if (!['empty', 'done', 'sources-ready'].includes(hubState) || !hasReusableCareerProfile) {
      setSavedAnalysisMeta(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (!window.electronAPI?.getLastJobAnalysisSnapshot) {
        if (!cancelled) setSavedAnalysisMeta(null);
        return;
      }
      try {
        const res = await window.electronAPI.getLastJobAnalysisSnapshot({ canvasFilePath, nodeId: id });
        if (cancelled) return;
        if (
          res?.success &&
          res.exists &&
          res.meta &&
          Array.isArray(res.snapshot?.jobs) &&
          res.snapshot.jobs.length > 0 &&
          res.snapshot?.profile &&
          isSavedAnalysisForCurrentHub(res.snapshot, res.meta, id, canvasFilePath, data.jobAnalysisClearedAt, data.jobAnalysisClearedRunId)
        ) {
          // FIX 4: `meta.targetRole` (electron/ipc/jobs.js's curated subset of
          // buildJobAnalysisSnapshot) is legacy-only and always '' under the
          // current Search Brief UI. `res.snapshot.jobPreferencePlan.titles`
          // (normalizeJobPreferencePlan's shape, electron/ipc/jobPreferences.js)
          // is what the main process actually persists for "what roles did
          // this saved scrape search" — `meta` itself omits jobPreferencePlan,
          // so read it off the full snapshot here and fold it into the local
          // state this panel renders from.
          setSavedAnalysisMeta({ ...res.meta, resolvedRoleTitles: savedAnalysisRoleTitles(res.snapshot) });
        } else {
          setSavedAnalysisMeta(null);
        }
      } catch {
        if (!cancelled) setSavedAnalysisMeta(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hubState, canvasFilePath, hasReusableCareerProfile, id, data.jobAnalysisClearedAt, data.jobAnalysisClearedRunId]);

  const handleOpenSavedPrompt = useCallback(async () => {
    if (!savedAnalysisMeta?.promptPath) return;
    try {
      await window.electronAPI?.openFile?.(savedAnalysisMeta.promptPath);
    } catch (err) {
      addToast({
        title: 'Could Not Open Saved Prompt',
        description: err?.message || String(err),
        type: 'error',
      });
    }
  }, [savedAnalysisMeta, addToast]);

  const handleResumeSavedScrape = useCallback(async (options = {}) => {
    const manualAiRunId = options?.manualAiRunId || createManualAiRunId(id);
    const resultMode = options?.recoveryMode === 'append-scored-jobs' ? 'append' : 'replace';
    const queueManagedByBoard = options?.queueManagedByBoard === true;
    const parentCancelled = options?.parentCancelled;
    const orchestratorNodeId = options?.orchestratorNodeId || null;
    if (isJobWorkflowDeletionPending(id)) {
      return searchRunOutcome('cancelled', { error: 'This Job Search is pending deletion.' });
    }
    if (!queueManagedByBoard && deferDirectSearchToBoard('Saved-scrape resume')) {
      return searchRunOutcome('not-ready', { error: 'Resume this connected search from its Job Board.' });
    }
    if (!queueManagedByBoard && findJobSearchBoardActiveRecoveryOwner(id, getNodes(), getEdges())) {
      addToast({
        title: 'Resume from Job Board',
        description: 'This saved Search recovery is reserved by its Job Board. Finish or cancel that Board first.',
        type: 'info',
      });
      return searchRunOutcome('paused', {
        error: 'This saved Search recovery is reserved by its Job Board.',
      });
    }
    if (hasPendingManualAiRetirement(getNode(id)?.data || {})) {
      return searchRunOutcome('not-ready', {
        error: 'Finish the older manual-AI cancellation cleanup before resuming this search.',
      });
    }
    const admissionData = getNode(id)?.data || data;
    if (
      admissionData.locked
      || !admissionData.resumeProfile
      || typeof admissionData.resumeProfile !== 'object'
      || processingRunsRef.current.active
      // A Board-owned saved-scrape replay has a durable job/profile snapshot
      // and does not contact a platform. Its parent has already validated the
      // exact recovery token, so a later, unrelated connection check must not
      // strand that recovery after reload. Standalone resumes remain blocked
      // until the selected-platform check has settled.
      || (!queueManagedByBoard && platformsVerifyingRef.current)
    ) {
      return searchRunOutcome('not-ready', { error: 'This saved Job Search is not ready to resume.' });
    }
    if (!window.electronAPI?.getLastJobAnalysisSnapshot) {
      return searchRunOutcome('failed', { error: 'Saved Job Search recovery is unavailable.' });
    }
    const admissionToken = Symbol(`resume-saved-job-search:${manualAiRunId}`);
    if (!queueManagedByBoard) {
      if (localQueueAdmissionRef.current) return searchRunOutcome('busy');
      localQueueAdmissionRef.current = admissionToken;
    }
    let processingToken = null;
    const currentId = id;
    const locallyCancelled = epoch.start();
    const cancelled = () => locallyCancelled()
      || (typeof parentCancelled === 'function' && parentCancelled());
    let lease = null;
    let standaloneRecoveryClaimedByBoard = false;

    try {
      if (!queueManagedByBoard) {
        lease = await moduleRunQueue.acquireModuleRun({
          nodeId: currentId,
          kind: 'jobsearch',
          lane: 'job-search',
          label: 'Resume saved job search',
          onQueued: ({ position }) => {
            updateGlobal(currentId, { queuedModuleRun: { label: 'Resuming saved job search', position } });
          },
          onQueueUpdate: ({ position }) => {
            updateGlobal(currentId, { queuedModuleRun: { label: 'Resuming saved job search', position } });
          },
          onStart: () => {
            if (cancelled() || isJobWorkflowDeletionPending(currentId)) throw new Error('Node deleted');
            const boardOwner = findJobSearchBoardRecoveryOwner(
              currentId,
              manualAiRunId,
              getNodes(),
              getEdges(),
            );
            const activeBoardOwner = findJobSearchBoardActiveRecoveryOwner(
              currentId,
              getNodes(),
              getEdges(),
            );
            if (
              boardOwner
              || activeBoardOwner
              || isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())
            ) {
              standaloneRecoveryClaimedByBoard = true;
              return;
            }
            updateGlobal(currentId, { queuedModuleRun: null });
          },
        });
      } else {
        if (!orchestratorNodeId) throw new Error('A board-managed recovery requires an orchestrator node id.');
        updateGlobal(currentId, { queuedModuleRun: null });
        EventLogger.log(`[JobSearch][${currentId}] Saved recovery queue delegated to Job Board ${orchestratorNodeId}`);
      }
      if (standaloneRecoveryClaimedByBoard) {
        updateGlobal(currentId, { queuedModuleRun: null });
        EventLogger.log(
          `[JobSearch][${currentId}] Queued saved recovery deferred to its durable Job Board owner`,
        );
        return searchRunOutcome('not-ready', {
          error: 'This saved recovery is managed by its connected Job Board.',
        });
      }
      const laneTurnData = getNode(currentId)?.data || null;
      if (
        !laneTurnData
        || laneTurnData.locked
        || isJobWorkflowDeletionPending(currentId)
        || (!queueManagedByBoard && platformsVerifyingRef.current)
        || (
          !queueManagedByBoard
          && (
            isJobSearchConnectedToBoard(currentId, getNodes(), getEdges())
            || findJobSearchBoardActiveRecoveryOwner(currentId, getNodes(), getEdges())
          )
        )
      ) {
        return searchRunOutcome('not-ready', {
          error: 'This saved Job Search became unavailable while it was queued.',
        });
      }
      processingToken = processingRunsRef.current.start();
      if (!processingToken) {
        return searchRunOutcome('busy', { error: 'This Job Search module is already running.' });
      }
      activeManualAiRunIdRef.current = manualAiRunId;
      setSavedAnalysisLoading(true);
      let res;
      try {
        res = await window.electronAPI.getLastJobAnalysisSnapshot({
          canvasFilePath,
          nodeId: id,
          jobRunId: savedAnalysisMeta?.runId || null,
        });
      } catch (error) {
        EventLogger.error(`[JobSearch][${id}] Saved scrape inspection failed:`, error);
        if (!queueManagedByBoard) {
          const message = error?.message || String(error);
          updateGlobal(currentId, { errorMessage: message });
          addToast({
            title: 'Saved Scrape Check Failed',
            description: 'The saved run was kept. Try Resume again when local storage is available.',
            type: 'error',
          });
        }
        return searchRunOutcome('recovery-inspection-failed', {
          runId: savedAnalysisMeta?.runId || data.jobRunId || null,
          error: error?.message || String(error),
        });
      }
      if (cancelled()) return searchRunOutcome('cancelled');
      if (res?.success === false) {
        const message = res.error || 'The saved scrape could not be inspected.';
        EventLogger.error(`[JobSearch][${id}] Saved scrape inspection failed: ${message}`);
        if (!queueManagedByBoard) {
          updateGlobal(currentId, { errorMessage: message });
          addToast({
            title: 'Saved Scrape Check Failed',
            description: 'The saved run was kept. Try Resume again when local storage is available.',
            type: 'error',
          });
        }
        return searchRunOutcome('recovery-inspection-failed', {
          runId: savedAnalysisMeta?.runId || data.jobRunId || null,
          error: message,
        });
      }
      const snapshot = res?.success && res.exists ? res.snapshot : null;
      const savedJobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
      const profile = snapshot?.profile;
      // New snapshots retain the raw evidence used by the scorer. A current
      // hub can supply it for a legacy snapshot created before this field.
      const careerData = snapshot?.careerData || laneTurnData.careerData || '';
      if (!snapshot || !profile || savedJobs.length === 0
        || !isSavedAnalysisForCurrentHub(
          snapshot,
          res?.meta,
          id,
          canvasFilePath,
          laneTurnData.jobAnalysisClearedAt,
          laneTurnData.jobAnalysisClearedRunId,
        )) {
        addToast({
          title: 'No Saved Scrape',
          description: 'No saved scrape data is available to resume.',
          type: 'error',
        });
        setSavedAnalysisMeta(null);
        return searchRunOutcome('not-ready', { error: 'No saved scrape data is available to resume.' });
      }

      // A saved analysis snapshot survives an ordinary completed search by
      // design. Its runId correlates provenance; it does not prove a live staging
      // manifest still needs finalization. Inspect the exact hub ledger before
      // deciding whether this replay should call completeJobRun again.
      let completeSnapshotRun = false;
      if (snapshot.runId && canvasFilePath && window.electronAPI?.peekJobRun) {
        let runInfo;
        try {
          runInfo = await window.electronAPI.peekJobRun({ canvasFilePath, nodeId: id });
        } catch (error) {
          return searchRunOutcome('recovery-inspection-failed', {
            runId: snapshot.runId,
            error: error?.message || 'Could not inspect the saved Job Search run before replaying it.',
          });
        }
        if (cancelled()) {
          return searchRunOutcome('cancelled', { runId: snapshot.runId });
        }
        if (runInfo?.success === false) {
          return searchRunOutcome('recovery-inspection-failed', {
            runId: snapshot.runId,
            error: runInfo.error || 'Could not inspect the saved Job Search run before replaying it.',
          });
        }
        if (runInfo?.found && runInfo.nodeId === id && runInfo.runId !== snapshot.runId) {
          return searchRunOutcome('recovery-inspection-failed', {
            runId: snapshot.runId,
            error: 'A different unfinished Job Search now owns this module’s recovery files.',
          });
        }
        completeSnapshotRun = runInfo?.found === true
          && runInfo.nodeId === id
          && runInfo.runId === snapshot.runId;
      }

      EventLogger.log(`[JobSearch][${id}] Resuming from saved scrape (${savedJobs.length} job(s))`);
      // Append recovery merges into the exact result generation visible at its
      // lane turn. Keep that immutable base across preference/scoring awaits;
      // using the render-time `data` closure can drop results committed while
      // this recovery was queued, and omitting the base makes the append helper
      // deliberately refuse the write.
      const recoveryBaseData = getNode(currentId)?.data || null;
      if (!recoveryBaseData) {
        return searchRunOutcome('cancelled', { runId: snapshot.runId || null });
      }
      const appendBaseRunId = recoveryBaseData.jobRunId || null;
      const appendBaseDisposition = recoveryBaseData.resultDisposition || null;
      const appendBaseFingerprint = moduleFingerprint(recoveryBaseData.scoredJobs);
      const appendCanCommit = () => {
        if (cancelled()) return false;
        const live = getNode(currentId)?.data;
        return !!live
          && (live.jobRunId || null) === appendBaseRunId
          && (live.resultDisposition || null) === appendBaseDisposition
          && moduleFingerprint(live.scoredJobs) === appendBaseFingerprint;
      };
      cancelCleanSourceCardDismiss();
      updateGlobal(currentId, { _boardRollbackSourceProgressFence: null });
      resetSourceProgress();
      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
      const activeTargetRole = String(snapshot.targetRole || '').trim();
      const activeJobPreferences = String(snapshot.jobPreferences ?? laneTurnData.jobPreferences ?? '').trim();
      const jobPreferencesInterpretation = snapshot.jobPreferencePlan
        ?? snapshot.preferencePlan
        ?? snapshot.snapshotContext?.jobPreferencePlan
        ?? snapshot.snapshotContext?.preferencePlan
        ?? null;
      updateGlobal(currentId, {
        errorMessage: null,
        rerunOutcome: null,
        rerunNotice: null,
        testModeNote: null,
        ...(resultMode === 'append' ? {} : { resultDisposition: null }),
        pendingJobs: null,
        pendingTargetRole: null,
        resumeProfile: profile,
        careerData,
        // Snapshot identity belongs to the profile/corpus it restores, not
        // the previous live hub. Legacy snapshots lacking it stay
        // non-recoverable instead of inheriting a stale fingerprint.
        resumeFingerprint: normalizeResumeProfileFingerprint(snapshot.profileFingerprint) || null,
        resumeSummary: buildResumeSummary(profile),
        resumeContext: {
          skills: profile.skills,
          experience: profile.experience_years,
        },
        targetRole: activeTargetRole,
        jobPreferences: activeJobPreferences,
        jobPreferencePlan: jobPreferencesInterpretation,
      });

      try {
        const locationSnapshot = snapshot.locationSnapshot || snapshot.snapshotContext?.locationSnapshot || (
          snapshot.snapshotContext?.searchLocation || snapshot.snapshotContext?.remoteResidences
            ? {
                searchLocation: normalizeStructuredLocation(snapshot.snapshotContext?.searchLocation),
                remoteResidences: normalizeRemoteResidences(snapshot.snapshotContext?.remoteResidences),
              }
            : null
        );
        // A recovered append can contain a subset that was already committed
        // before the app restarted. Re-evaluating it would double-count
        // preferences and create a second audit even though scored-job merging
        // later hides the duplicate. Mirror the normal late-USAJobs gate here.
        const existingPreferencePool = Array.isArray(recoveryBaseData.preferenceCandidatePool)
          ? recoveryBaseData.preferenceCandidatePool
          : (Array.isArray(recoveryBaseData.scoredJobs) ? recoveryBaseData.scoredJobs : []);
        const jobsToEvaluate = resultMode === 'append'
          ? uniqueJobsAcrossSources(existingPreferencePool, savedJobs)
          : savedJobs;
        if (resultMode === 'append' && jobsToEvaluate.length === 0) {
          if (!appendCanCommit()) {
            return searchRunOutcome(cancelled() ? 'cancelled' : 'superseded', {
              runId: snapshot.runId || null,
              error: 'The saved append target changed before its duplicate check completed.',
            });
          }
          await completeManualAiRun(manualAiRunId);
          if (!appendCanCommit()) {
            return searchRunOutcome(cancelled() ? 'cancelled' : 'superseded', {
              runId: snapshot.runId || null,
              error: 'The saved append target changed while its handoff was being retired.',
            });
          }
          return searchRunOutcome('completed', {
            runId: recoveryBaseData.jobRunId || null,
            resultDisposition: recoveryBaseData.resultDisposition || null,
          });
        }
        const preferenceResult = await evaluatePreferencesForRun({
          careerData,
          activeTargetRole,
          jobs: jobsToEvaluate,
          profile,
          activeJobPreferences,
          jobPreferencesInterpretation,
          locationSnapshot,
          manualAiRunId,
          manualAiRecoveryMode: resultMode === 'append' ? 'append-scored-jobs' : 'resume-saved-scrape',
        });
        if (cancelled()) return searchRunOutcome('cancelled', { runId: snapshot.runId || null });
        if (preferenceResult.jobs.length === 0) {
          let completion = null;
          if (resultMode === 'append') {
            const appendCommitted = await appendJobsToDoneCanvas({
              scoredJobs: [],
              filteredWarnings: Array.isArray(recoveryBaseData.scrapeWarnings)
                ? recoveryBaseData.scrapeWarnings
                : [],
              gatheredDelta: jobsToEvaluate.length,
              preferenceMatchedDelta: preferenceResult.matchedCount,
              preferenceFilteredDelta: preferenceResult.filteredCount,
              preferenceEvaluation: preferenceResult.evaluation,
              preferenceCandidatePool: preferenceResult.candidatePool,
              baseData: recoveryBaseData,
              emptyResultDisposition: 'preference-filtered',
              canCommit: appendCanCommit,
            });
            if (!appendCommitted) {
              return searchRunOutcome(cancelled() ? 'cancelled' : 'superseded', {
                runId: snapshot.runId || null,
                error: 'The saved append target changed before preference evaluation completed.',
              });
            }
          } else {
            completion = completeSnapshotRun
              ? await completeJobRun(snapshot.runId, 'completed', 'preference-filtered', canvasFilePath, 0, moduleFingerprint([]), cancelled)
              : null;
            if (cancelled()) return searchRunOutcome('cancelled', { runId: snapshot.runId || null });
            updateGlobal(currentId, {
              hubState: 'done', scoredJobs: [], finalSourceCounts: {}, resultCount: 0, totalScoredCount: 0,
              scrapedCount: 0,
              gatheredCount: snapshot.sourceGatheredCount ?? savedJobs.length,
              preferenceMatchedCount: preferenceResult.matchedCount,
              preferenceFilteredCount: preferenceResult.filteredCount,
              preferenceEvaluation: preferenceResult.evaluation,
              preferenceCandidatePool: preferenceResult.candidatePool,
              pendingJobs: null,              resultDisposition: 'preference-filtered',
              errorMessage: terminalFinalizationError(completeSnapshotRun ? snapshot.runId : null, canvasFilePath, completion),
            });
          }
          await completeManualAiRun(manualAiRunId);
          if (cancelled()) {
            return searchRunOutcome('cancelled', { runId: snapshot.runId || null });
          }
          // Read the disposition that the guarded append actually committed.
          // A previously empty result becomes an authoritative
          // preference-filtered result here, while a non-empty base remains
          // scored. Returning the stale base disposition makes Board recovery
          // reject its otherwise successful child commit.
          const resultDisposition = resultMode === 'append'
            ? (getNode(currentId)?.data?.resultDisposition || null)
            : 'preference-filtered';
          const completionError = resultMode === 'append'
            ? null
            : terminalFinalizationError(completeSnapshotRun ? snapshot.runId : null, canvasFilePath, completion);
          return completionError
            ? searchRunOutcome('recovery-finalization-failed', { runId: snapshot.runId || null, resultDisposition, error: completionError })
            : searchRunOutcome('completed', { runId: snapshot.runId || recoveryBaseData.jobRunId || null, resultDisposition });
        }
        return await runScoringAndSpawn({
          profile,
          careerData,
          jobs: preferenceResult.jobs,
          gatheredCount: snapshot.sourceGatheredCount
            ?? snapshot.searchFunnel?.relevanceKept
            ?? snapshot.searchFunnel?.raw
            ?? snapshot.gatheredJobCount
            ?? savedJobs.length,
          scrapeWarnings: resultMode === 'append'
            ? (Array.isArray(recoveryBaseData.scrapeWarnings) ? recoveryBaseData.scrapeWarnings : [])
            : [],
          activeTargetRole,
          activeJobPreferences,
          jobPreferencesInterpretation,
          preferenceMatchedCount: preferenceResult.matchedCount,
          preferenceFilteredCount: preferenceResult.filteredCount,
          preferenceEvaluation: preferenceResult.evaluation,
          preferenceCandidatePool: preferenceResult.candidatePool,
          originalPos,
          cancelled,
          jobRunId: snapshot.runId || null,
          // Re-analysis snapshots have no search-run lifecycle. Only complete
          // a staged search when this recovered snapshot owns that run token.
          completeRun: completeSnapshotRun,
          locationSnapshot,
          manualAiRunId,
          resultMode,
          gatheredDelta: resultMode === 'append' ? jobsToEvaluate.length : null,
          appendBaseData: resultMode === 'append' ? recoveryBaseData : null,
          appendCanCommit,
        });
      } catch (error) {
        if (queueManagedByBoard && isJobBoardUserCancellation(error)) {
          const control = boardRunControlRef.current;
          if (
            control
            && control.orchestratorNodeId === orchestratorNodeId
            && typeof cancelBoardRunRef.current === 'function'
          ) {
            let result;
            if (control.rollbackApplied) {
              await control.rollbackPromise;
              result = { runId: control.cancelledRunId || null };
            } else {
              result = await cancelBoardRunRef.current({
                orchestratorNodeId,
                boardRunId: control.boardRunId,
                reason: 'manual-ai-cancelled',
              });
            }
            return searchRunOutcome('cancelled', { runId: result?.runId || snapshot.runId || null });
          }
        }
        if (cancelled() || isNodeDeletedAbort(error)) {
          return searchRunOutcome('cancelled', { runId: snapshot.runId || null });
        }
        EventLogger.error('[JobSearch] Resume from saved scrape failed:', error);
        const hubHasResults = (getNode(currentId)?.data?.scoredJobs?.length || 0) > 0;
        updateGlobal(currentId, {
          hubState: hubHasResults ? 'done' : 'empty',
          resultDisposition: hubHasResults ? 'incomplete' : null,
          errorMessage: error?.message || String(error),
          rerunOutcome: null,
          rerunNotice: null,
        });
        return searchRunOutcome('failed', {
          runId: snapshot.runId || null,
          resultDisposition: hubHasResults ? 'incomplete' : null,
          error,
        });
      }
    } finally {
      if (!queueManagedByBoard && getNode(currentId)) {
        updateGlobal(currentId, (node) => (
          node?.data?.queuedModuleRun?.label === 'Resuming saved job search'
            ? { queuedModuleRun: null }
            : null
        ));
      }
      if (activeManualAiRunIdRef.current === manualAiRunId) activeManualAiRunIdRef.current = null;
      if (processingToken && isMountedRef.current) processingRunsRef.current.finish(processingToken);
      if (isMountedRef.current) setSavedAnalysisLoading(false);
      if (!queueManagedByBoard && localQueueAdmissionRef.current === admissionToken) {
        localQueueAdmissionRef.current = null;
      }
      if (lease) await waitForRendererCommitFrame();
      lease?.release();
    }
  }, [addToast, appendJobsToDoneCanvas, cancelCleanSourceCardDismiss, canvasFilePath, data, epoch, getEdges, getNode, getNodes, id, resetSourceProgress, runScoringAndSpawn, updateGlobal, isMountedRef, completeJobRun, completeManualAiRun, evaluatePreferencesForRun, savedAnalysisMeta?.runId, moduleRunQueue, deferDirectSearchToBoard]);

  resumeSavedScrapeRef.current = handleResumeSavedScrape;

  const autoResumedManualAiRunRef = useRef(null);
  const manualAiAutoResumeAttemptRef = useRef(null);
  const [manualAiAutoResumeRetryRevision, setManualAiAutoResumeRetryRevision] = useState(0);
  useEffect(() => {
    const resume = data.manualAiResume;
    if (!resume?.runId) return;
    if (isJobWorkflowDeletionPending(id)) {
      // Do not consume any recovery latch while deletion is still reversible.
      // An already-running exact retirement keeps its attempt token until it
      // settles; otherwise the lifecycle revision retries after restoration.
      if (manualAiAutoResumeAttemptRef.current?.runId !== resume.runId) {
        autoResumedManualAiRunRef.current = null;
      }
      return;
    }
    if (normalizeManualAiCleanupReceipts(data.manualAiCleanupReceipts)
      .some(receipt => receipt.cancellationPending === true)) return;
    const boardRecoveryOwner = findJobSearchBoardRecoveryOwner(id, resume.runId, getNodes(), getEdges());
    if (boardRecoveryOwner?.missingPlan) {
      if (
        autoResumedManualAiRunRef.current === resume.runId
        || manualAiAutoResumeAttemptRef.current?.runId === resume.runId
      ) return;
      const cleanupAttemptToken = Symbol(`orphaned-board-cleanup:${resume.runId}`);
      manualAiAutoResumeAttemptRef.current = { runId: resume.runId, token: cleanupAttemptToken };
      // An explicitly Board-owned marker whose parent plan disappeared cannot
      // be replayed as standalone work and no Board can ever claim it. Retire
      // only that orphaned handoff; preserve the Search's completed data.
      autoResumedManualAiRunRef.current = resume.runId;
      void (async () => {
        try {
          await settleManualAiRetirement({
            runId: resume.runId,
            marker: resume,
            retirementReason: 'orphaned-board-recovery',
            requireCancellationAck: true,
            cancellationReason: 'orphaned-board-recovery',
          });
          updateGlobal(id, { queuedModuleRun: null });
        } catch (error) {
          autoResumedManualAiRunRef.current = null;
          EventLogger.error(`[JobSearch][${id}] Orphaned Board recovery cleanup failed:`, error);
        } finally {
          if (manualAiAutoResumeAttemptRef.current?.token === cleanupAttemptToken) {
            manualAiAutoResumeAttemptRef.current = null;
          }
        }
      })();
      return;
    }
    if (boardRecoveryOwner) {
      // The Board's durable plan owns both queue admission and the exact child
      // rollback identity. Its recovery effect re-invokes runForJobBoard with
      // this descriptor; a parallel standalone replay would deadlock or race it.
      EventLogger.log(
        `[JobSearch][${id}] Manual-AI auto-resume deferred to Job Board ${boardRecoveryOwner.orchestratorNodeId}`,
      );
      return;
    }
    if (resume.retirementPending) {
      if (
        autoResumedManualAiRunRef.current === resume.runId
        || manualAiAutoResumeAttemptRef.current?.runId === resume.runId
      ) return;
      // Reset/orphan cancellation publishes this marker before awaiting its
      // node-scoped acknowledgement. That explicit caller already owns cleanup;
      // starting the mount recovery path as well can race a successful Reset
      // with a second, later failure that recreates the retired marker.
      if (attemptedManualAiCleanupRunIdsRef.current.has(resume.runId)) return;
      attemptedManualAiCleanupRunIdsRef.current.add(resume.runId);
      const cleanupAttemptToken = Symbol(`manual-ai-retirement:${resume.runId}`);
      manualAiAutoResumeAttemptRef.current = { runId: resume.runId, token: cleanupAttemptToken };
      autoResumedManualAiRunRef.current = resume.runId;
      void settleManualAiRetirement({
        runId: resume.runId,
        marker: resume,
        retirementReason: resume.retirementReason || 'cleanup',
        requireCancellationAck: resume.cancellationPending === true,
        cancellationReason: resume.cancellationReason || resume.retirementReason || 'manual-ai-cancelled',
      }).catch((error) => {
        autoResumedManualAiRunRef.current = null;
        if (isJobWorkflowDeletionPending(id)) {
          attemptedManualAiCleanupRunIdsRef.current.delete(resume.runId);
          setManualAiAutoResumeRetryRevision(revision => revision + 1);
          return;
        }
        updateGlobal(id, { errorMessage: error?.message || 'Saved manual-AI cleanup did not finish.' });
      }).finally(() => {
        if (manualAiAutoResumeAttemptRef.current?.token === cleanupAttemptToken) {
          manualAiAutoResumeAttemptRef.current = null;
        }
      });
      return;
    }
    if (cancelledBoardManualAiRunIdsRef.current.has(resume.runId)) return;
    // Canvas nodes mount one render before the silently restored file path is
    // published through navigation context. Scoring snapshots are file-scoped,
    // so wait for that path instead of consuming the one-shot resume guard with
    // an unscoped lookup.
    if (!canvasFilePath) return;
    // Evaluate transient gates before the one-shot latch. A queued recovery can
    // be rejected by a reversible delete or a lock applied while it waits; once
    // that gate clears, the durable marker must remain eligible to retry.
    if (
      processingRunsRef.current.active
      || data.locked
      || platformsVerifying
      || boardRecoveryOwnsActions
    ) return;
    if (!['empty', 'done', 'sources-ready'].includes(hubState)) return;
    if (
      autoResumedManualAiRunRef.current === resume.runId
      || manualAiAutoResumeAttemptRef.current?.runId === resume.runId
    ) return;
    const attemptToken = Symbol(`manual-ai-auto-resume:${resume.runId}`);
    manualAiAutoResumeAttemptRef.current = { runId: resume.runId, token: attemptToken };
    autoResumedManualAiRunRef.current = resume.runId;

    const start = async () => {
      EventLogger.log(`[JobSearch][${id}] Auto-resuming manual AI run ${resume.runId} at ${resume.task || 'pending step'}`);
      // A saved-scrape replay can be interrupted during preference evaluation,
      // before it reaches the scorer. Both replace and append replays already
      // have the exact saved snapshot, so do not fall back to a fresh search
      // merely because the pending task is `job-preference`.
      if (isSavedScrapeManualAiResume(resume)) {
        return await handleResumeSavedScrape({
          manualAiRunId: resume.runId,
          recoveryMode: resume.recoveryMode,
        });
      }
      const savedPaths = [
        ...(Array.isArray(data.filePaths) ? data.filePaths : []),
        ...(Array.isArray(data.careerFilePaths) ? data.careerFilePaths : []),
        data.filePath,
      ].filter(Boolean);
      const uniquePaths = [...new Set(savedPaths)];
      if (['career-file-extract', 'resume-parse'].includes(resume.task) && uniquePaths.length > 0) {
        return await runPipeline({ filePaths: uniquePaths, runOrigin: 'initial', manualAiRunId: resume.runId });
      } else if (data.resumeProfile) {
        return await runPipeline({ profile: data.resumeProfile, runOrigin: 'rerun-button', manualAiRunId: resume.runId });
      } else {
        autoResumedManualAiRunRef.current = null;
        return searchRunOutcome('not-ready');
      }
    };
    void start().then((outcome) => {
      const liveData = getNode(id)?.data || {};
      const liveBoardOwner = findJobSearchBoardActiveRecoveryOwner(
        id,
        getNodes(),
        getEdges(),
      );
      const retryableTransient = outcome?.status === 'busy'
        || outcome?.status === 'cancelled'
        || (
          !!liveBoardOwner
          && (outcome?.status === 'paused' || outcome?.status === 'not-ready')
        )
        || (
          outcome?.status === 'not-ready'
          && (
            isJobWorkflowDeletionPending(id)
            || liveData.locked
            || platformsVerifying
          )
        );
      if (retryableTransient) {
        autoResumedManualAiRunRef.current = null;
        setManualAiAutoResumeRetryRevision(revision => revision + 1);
      }
    }).catch((error) => {
      autoResumedManualAiRunRef.current = null;
      EventLogger.error(`[JobSearch][${id}] Manual-AI auto-resume failed:`, error);
    }).finally(() => {
      if (manualAiAutoResumeAttemptRef.current?.token === attemptToken) {
        manualAiAutoResumeAttemptRef.current = null;
      }
    });
  }, [activeBoardRecoveryOwnerKey, boardRecoveryOwnsActions, canvasFilePath, data.manualAiCleanupReceipts, data.manualAiResume, data.locked, data.filePath, data.filePaths, data.careerFilePaths, data.resumeProfile, deletionLifecycleRevision, getEdges, getNode, getNodes, handleResumeSavedScrape, hubState, id, manualAiAutoResumeRetryRevision, platformsVerifying, runPipeline, settleManualAiRetirement, updateGlobal]);

  const handleDismissError = useCallback(() => {
    EventLogger.log(`[JobSearch][${id}] User clicked Dismiss Error`);
    updateGlobal(id, { errorMessage: null, rerunOutcome: null, rerunNotice: null, testModeNote: null });
    // Cleanup orphaned platform cards if this hub never produced results (the
    // results cascade lives on a Job Board Module now, so "has results" = stored
    // scoredJobs rather than on-canvas job cards).
    const hubHasResults = (getNode(id)?.data?.scoredJobs?.length || 0) > 0;
    if (!hubHasResults) {
      EventLogger.log(`[JobSearch][${id}] Dismissing error with no stored results; cleaning up orphaned source cards`);
      cleanupAllJobChildren();
    }
  }, [id, updateGlobal, getNode, cleanupAllJobChildren]);

  const handleRetryFailed = useCallback(() => {
    if (isJobWorkflowDeletionPending(id)) return;
    if (data.locked) return;
    const liveData = getNode(id)?.data || {};
    const supersededCleanupReceipts = normalizeManualAiCleanupReceipts(
      liveData.manualAiCleanupReceipts,
    );
    if (supersededCleanupReceipts.length > 0 && !liveData.manualAiResume) {
      supersededCleanupReceipts.forEach((receipt) => {
        attemptedManualAiCleanupRunIdsRef.current.delete(receipt.runId);
      });
      void Promise.all(supersededCleanupReceipts.map(receipt => settleManualAiRetirement({
        runId: receipt.runId,
        marker: receipt,
        retirementReason: receipt.retirementReason || 'superseded-cleanup',
        requireCancellationAck: receipt.cancellationPending === true,
        cancellationReason: receipt.cancellationReason
          || receipt.retirementReason
          || 'manual-ai-cancelled',
        superseded: true,
      }))).catch((error) => {
        updateGlobal(id, {
          errorMessage: error?.message || 'An older saved manual-AI handoff still needs cleanup.',
        });
      });
      return;
    }
    const manualRetirement = liveData.manualAiResume;
    if (manualRetirement?.runId && manualRetirement.retirementPending) {
      autoResumedManualAiRunRef.current = manualRetirement.runId;
      void settleManualAiRetirement({
        runId: manualRetirement.runId,
        marker: manualRetirement,
        retirementReason: manualRetirement.retirementReason || 'cleanup',
        requireCancellationAck: manualRetirement.cancellationPending === true,
        cancellationReason: manualRetirement.cancellationReason
          || manualRetirement.retirementReason
          || 'manual-ai-cancelled',
      }).catch((error) => {
        autoResumedManualAiRunRef.current = null;
        updateGlobal(id, { errorMessage: error?.message || 'Saved manual-AI cleanup did not finish.' });
      });
      return;
    }
    const finalizationRecovery = getNode(id)?.data?.terminalFinalizationRecovery;
    if (finalizationRecovery?.kind === 'terminal-finalization') {
      if (localQueueAdmissionRef.current) return;
      const admissionToken = Symbol(`finalize-job-search:${finalizationRecovery.runId || id}`);
      localQueueAdmissionRef.current = admissionToken;
      const cancelled = epoch.start();
      void (async () => {
        let lease = null;
        try {
          lease = await moduleRunQueue.acquireModuleRun({
            nodeId: id,
            kind: 'jobsearch-finalization',
            lane: 'job-search',
            label: 'Finalize job search',
            onQueued: ({ position }) => updateGlobal(id, {
              queuedModuleRun: { label: 'Finalizing job search', position },
            }),
            onQueueUpdate: ({ position }) => updateGlobal(id, {
              queuedModuleRun: { label: 'Finalizing job search', position },
            }),
            onStart: () => {
              if (cancelled() || isJobWorkflowDeletionPending(id)) throw new Error('Node deleted');
              updateGlobal(id, { queuedModuleRun: { label: 'Finalizing job search', position: 0 } });
            },
          });
          const postLeaseData = getNode(id)?.data || null;
          if (
            cancelled()
            || isJobWorkflowDeletionPending(id)
            || !postLeaseData
            || postLeaseData.locked
            || hasPendingManualAiRetirement(postLeaseData)
          ) return;
          const liveBoardOwner = findJobSearchBoardActiveRecoveryOwner(
            id,
            getNodes(),
            getEdges(),
          );
          if (liveBoardOwner) {
            addToast({
              title: 'Finish from Job Board',
              description: 'A Job Board claimed this Search while terminal cleanup was queued. Retry or cancel that Board first.',
              type: 'info',
            });
            return;
          }
          const liveRecovery = getNode(id)?.data?.terminalFinalizationRecovery;
          if (
            liveRecovery?.kind !== 'terminal-finalization'
            || liveRecovery.runId !== finalizationRecovery.runId
          ) return;
          const outcome = await retryTerminalFinalization(liveRecovery, cancelled);
          if (cancelled() || !getNode(id)) return;
          if (outcome?.status !== 'completed') {
            updateGlobal(id, {
              errorMessage: outcome?.error || terminalFinalizationError(
                liveRecovery.runId,
                canvasFilePath,
                null,
              ),
            });
          }
        } catch (error) {
          if (!cancelled() && !isNodeDeletedAbort(error) && getNode(id)) {
            updateGlobal(id, {
              errorMessage: error?.message || 'The job search could not finish its durable cleanup.',
            });
          }
        } finally {
          if (localQueueAdmissionRef.current === admissionToken) {
            localQueueAdmissionRef.current = null;
          }
          if (!cancelled() && getNode(id)) {
            updateGlobal(id, (node) => (
              node?.data?.queuedModuleRun?.label === 'Finalizing job search'
                ? { queuedModuleRun: null }
                : null
            ));
          }
          if (lease) await waitForRendererCommitFrame();
          lease?.release();
        }
      })();
      return;
    }
    if (deferDirectSearchToBoard('Error retry')) return;
    EventLogger.log(`[JobSearch][${id}] User clicked Try Again on error banner`);
    updateGlobal(id, { errorMessage: null, rerunOutcome: null, rerunNotice: null, testModeNote: null });
    handleRerun({ frameSourceCards: false });
  }, [addToast, canvasFilePath, data.locked, deferDirectSearchToBoard, epoch, getEdges, getNode, getNodes, id, moduleRunQueue, retryTerminalFinalization, settleManualAiRetirement, updateGlobal, handleRerun]);

  const savedAnalysisWarning = getSavedAnalysisWarning(savedAnalysisMeta, id, canvasFilePath);
  const savedScoreReadyCount = Math.max(0, Number(savedAnalysisMeta?.gatheredJobCount) || 0);
  const savedSourceGatheredCount = Number.isFinite(Number(savedAnalysisMeta?.sourceGatheredCount))
    ? Math.max(savedScoreReadyCount, Math.max(0, Math.floor(Number(savedAnalysisMeta.sourceGatheredCount))))
    : savedScoreReadyCount;
  // Saved snapshots are hub-scoped, so an older run can legitimately exist
  // beside this hub's current done state. Only use its durable funnel when it
  // belongs to this exact run token.
  const savedAnalysisMatchesCurrentRun = !!savedAnalysisMeta?.runId
    && savedAnalysisMeta.runId === data.jobRunId;
  const doneGatheredCount = savedAnalysisMatchesCurrentRun
    ? Math.max(Number(data.gatheredCount) || 0, savedSourceGatheredCount)
    : data.gatheredCount;
  // A staging-sidecar recovery and a saved scoring snapshot are both recovery
  // artifacts, even when they came from different runs. Give the unfinished
  // run priority so this module never presents competing recovery cards.
  const showUnfinishedRunBanner = Boolean(
    resumeOffer
    && !data.queuedModuleRun
    && !data.terminalFinalizationRecovery
    && !activeBoardRecoveryOwnerKey
    && (hubState === 'empty' || hubState === 'done')
  );
  const shouldShowSavedAnalysisPanel = !!savedAnalysisMeta && !showUnfinishedRunBanner;
  // FIX 4: prefer the resolved Search Brief titles (folded into meta by the
  // getLastJobAnalysisSnapshot effect above — see savedAnalysisRoleTitles);
  // fall back to the legacy meta.targetRole only for a snapshot saved before
  // the Search Brief replaced the standalone Target role box.
  const savedAnalysisRoleLabel = Array.isArray(savedAnalysisMeta?.resolvedRoleTitles)
    && savedAnalysisMeta.resolvedRoleTitles.length > 0
    ? savedAnalysisMeta.resolvedRoleTitles.join(', ')
    : String(savedAnalysisMeta?.targetRole || '').trim();
  const savedAnalysisPanel = shouldShowSavedAnalysisPanel ? (
    <div className="mt-2 w-full rounded-md border border-white/10 bg-white/5 px-2 py-2 text-left">
      <div className="text-[9px] uppercase tracking-[0.14em] text-white/25">Saved Scrape</div>
      <div className="mt-1 text-[10px] text-white/65">
        {savedSourceGatheredCount} found
        {savedSourceGatheredCount !== savedScoreReadyCount ? ` • ${savedScoreReadyCount} score-ready` : ''}
        {savedAnalysisMeta.selectedJobCount ? ` • ${savedAnalysisMeta.selectedJobCount} selected for AI` : ''}
      </div>
      {!!savedAnalysisRoleLabel && (
        <div className="text-[9px] text-white/35">{savedAnalysisRoleLabel}</div>
      )}
      <div className="text-[9px] text-white/30">
        {savedAnalysisMeta.createdAt ? new Date(savedAnalysisMeta.createdAt).toLocaleString() : 'Saved locally'}
      </div>
      {!!savedAnalysisMeta.resumeSummary && (
        <div className="mt-1 text-[9px] text-white/25">{savedAnalysisMeta.resumeSummary}</div>
      )}
      {!!savedAnalysisWarning && (
        <div className="mt-1 text-[9px] text-amber-300/80">{savedAnalysisWarning}</div>
      )}
      {boardRecoveryOwnsActions && (
        <div className="mt-2 text-[9px] leading-snug text-white/35">
          {managedByJobBoard
            ? 'Saved results are kept for reference. Start searches from the connected Job Board with Search selected & combine.'
            : 'Saved results are kept for reference while the previous Job Board recovery settles. Direct scoring returns when that recovery finishes or is cancelled.'}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        {!boardRecoveryOwnsActions && (
          <button
            className="nodrag flex-1 rounded border border-blue-400/30 bg-blue-400/10 px-2 py-1 text-[9px] text-blue-100 hover:bg-blue-400/15 disabled:cursor-default disabled:opacity-50"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={handleResumeSavedScrape}
            disabled={savedAnalysisLoading || controlsLocked}
          >
            {savedAnalysisLoading ? 'Re-scoring…' : 'Re-score saved results'}
          </button>
        )}
        <button
          className="nodrag rounded border border-white/10 bg-white/5 px-2 py-1 text-[9px] text-white/55 hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleOpenSavedPrompt}
          type="button"
          disabled={!savedAnalysisMeta.promptPath}
          title={savedAnalysisMeta.promptPath ? 'Open the saved AI scoring prompt' : 'No verified prompt file is available for this recovered snapshot'}
        >
          Open prompt
        </button>
      </div>
    </div>
  ) : null;

  // Non-blocking "resume an unfinished run?" banner — only in idle states so it
  // never overlays a live pipeline. A connected Board owns continuation;
  // standalone Searches retain their direct resume action.
  const resumeBanner = showUnfinishedRunBanner ? (
    <div className="m-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/30" onPointerDown={(e) => e.stopPropagation()}>
      <div className="text-amber-200/90 text-[11px] font-medium leading-snug">Unfinished job search found</div>
      <div className="text-amber-200/60 text-[10px] leading-snug mt-0.5">
        {resumeOffer.gatheredCount} job(s) gathered from {resumeOffer.doneSources}/{resumeOffer.totalSources} source(s){resumeOffer.stage ? ` · stopped at ${resumeOffer.stage}` : ''}.
        {/* State the observation, not an asserted cause: a legacy owner-unknown
            offer may not share this hub's history, so naming lost career files
            would be a guess — a virgin hub never had them. */}
        {boardRecoveryOwnsActions && resumeRunActionable
          ? ' Continue from the connected Job Board with Search selected & combine. Start fresh discards this unfinished run.'
          : resumeRunActionable
          ? ' Resume to continue it, or start fresh.'
          : canResumeOffer
            ? (resumeOffer.resumable === false
                ? ' This recovery is older than 24 hours; start fresh to clear it safely.'
                : !offeredResumeFingerprint
                  ? ' Start fresh — this run predates profile-safe recovery metadata.'
                  : !activeResumeFingerprint
                    ? ' Start fresh — this Job Search no longer has the profile fingerprint that created this run.'
                    : !resumeProfileMatches
                      ? ' Start fresh — the career profile changed after this run was staged.'
                      : ' Start fresh — this run cannot be resumed from this module.')
            : ` Start fresh — this run targeted ${resumeOffer.locationRecorded ? (offeredResumeLocation || 'no location') : 'an unrecorded legacy location'}, not the current ${activeResumeLocation || 'no location'}.`}
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {!boardRecoveryOwnsActions && resumeRunActionable && <button
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/80 text-black hover:bg-amber-400"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleResumeRun}
          disabled={controlsLocked}
        >Resume</button>}
        <button
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-white/5 text-white/60 hover:bg-white/10"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleDiscardResume}
          disabled={controlsLocked}
        >Start fresh</button>
      </div>
    </div>
  ) : null;

  const banner = (
    <>
      {data.queuedModuleRun && !isProcessing && (
        <div
          className="m-2 rounded-md border border-blue-400/25 bg-blue-500/10 px-2 py-1.5 text-[10px] text-blue-100/70"
          onPointerDown={(e) => e.stopPropagation()}
          role="status"
        >
          {data.queuedModuleRun.label || 'Job Search work'} is queued
          {Number.isFinite(data.queuedModuleRun.position) ? ` · position ${data.queuedModuleRun.position}` : ''}.
          {' '}Search controls are paused until it starts.
        </div>
      )}
      {resumeBanner}
      {(data.errorMessage || data.terminalFinalizationRecovery) ? (
        <HubErrorBanner
          errorMessage={data.errorMessage || terminalFinalizationError(
            data.terminalFinalizationRecovery?.runId,
            canvasFilePath,
            null,
          )}
          locked={errorControlsLocked}
          onRetry={boardRecoveryOwnsActions ? null : handleRetryFailed}
          onDismiss={data.terminalFinalizationRecovery ? null : handleDismissError}
        />
      ) : data.testModeNote ? (
        <div className="m-2 p-2 rounded-md bg-blue-500/10 border border-blue-500/20" onPointerDown={(e) => e.stopPropagation()}>
          <div className="text-blue-300/80 text-[10px] leading-snug">{data.testModeNote}</div>
        </div>
      ) : null}
    </>
  );

  return (
    <HubContainer
      hubState={hubState}
      theme="blue"
      width={330}
      height={undefined}
      minHeight={hubState === 'empty' ? 140 : 100}
      onDrop={handleDrop}
      dropsBlocked={platformsVerifying || inputDropsBlocked || controlsLocked}
      verifyProgress={platformsVerifying ? { done: verifyDone, total: verifyTotal } : null}
      dragHover={data.dragHover || null}
      dropBlockedLabel={dropBlockedLabel}
    >
        {/* Empty state — drop zone (+ banner if a prior attempt failed) */}
        {hubState === 'empty' && (
          <>
            {banner}
            <div className="flex flex-col items-center justify-center py-8 px-4 cursor-default">
              <Briefcase size={28} className="text-blue-400/40 mb-3" />
              {platformsVerifying ? (
                <p className="text-white/40 text-sm font-medium">Checking connections…</p>
              ) : (inputDropsBlocked && hasCareerIdentity) ? (
                // Gated on real career identity, not merely on drops being
                // blocked: a LOCKED virgin hub has nothing retained, so it falls
                // through to the normal drop copy (drops still bounce off
                // dropsBlocked/handleDrop, and the drag chip still says "Locked").
                <>
                  <p className="text-white/40 text-sm font-medium">Career files retained</p>
                  {/* Both actions below are hidden while data.locked, so the
                      subtitle must not name them — it would describe buttons
                      that aren't there. */}
                  <p className="text-white/25 text-[10px] mt-1 text-center">{controlsLocked
                    ? (data.locked ? 'Unlock this module to re-run it or change its files' : 'Queued work will start automatically')
                    : boardRecoveryOwnsActions
                      ? (managedByJobBoard
                        ? 'Ready — run it from the connected Job Board, or clear these files'
                        : 'A Job Board recovery is settling. Direct search controls return when it finishes or is cancelled.')
                      : 'Re-run with these files, or clear them to search with different ones'}</p>
                  {hasRunnableCareerInput && !controlsLocked && !boardRecoveryOwnsActions && (
                    <button
                      type="button"
                      className="nodrag mt-3 px-3 py-1 rounded-full bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 text-[10px] border border-blue-500/20 transition-colors"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleRerun(); }}
                    >
                      {hasReusableCareerProfile ? 'Re-run Search' : 'Run Search'}
                    </button>
                  )}
                  {/* Not gated on hasReusableCareerProfile — a partially-wedged
                      identity (locked with no parsed profile) is exactly the
                      case that most needs clearing. */}
                  {!controlsLocked && !activeBoardRecoveryOwnerKey && (
                    <button
                      type="button"
                      className="nodrag mt-1.5 px-3 py-1 rounded-full bg-white/5 text-white/45 hover:bg-white/10 hover:text-white/70 text-[10px] border border-white/10 transition-colors"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleClearCareerFiles(e); }}
                    >
                      Clear career files
                    </button>
                  )}
                </>
              ) : (
                <>
                {/* A LOCKED virgin hub lands here (nothing retained to describe),
                    and its drops are silently refused — don't invite one. */}
                  <p className="text-white/40 text-sm font-medium">{controlsLocked ? (data.locked ? 'Module locked' : 'Search queued') : 'Drop your career files'}</p>
                  <p className="text-white/25 text-[10px] mt-1 text-center">{controlsLocked
                    ? (data.locked ? 'Unlock it to drop career files' : 'Wait for the queued work to start')
                    : 'Résumé, portfolio, project notes — any number of files'}</p>
                </>
              )}
              {/* Completion history belongs to this module, not its current career
                  files. Keep it visible after Clear career files so the user can
                  distinguish an intentionally cleared hub from one that never ran. */}
              {!!lastCompletedRunAtText && (
                <p className="text-white/35 text-[9px] mt-1">Last completed: {lastCompletedRunAtText}</p>
              )}
              {!platformsVerifying && <div
                className="nodrag mt-4 w-full flex flex-col items-stretch gap-1.5 text-[10px] text-white/40"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <label className="flex flex-col gap-1">
                  <span>Search Brief <span className="text-white/25">(optional)</span></span>
                  <textarea
                    data-native-undo="true"
                    value={jobPreferences}
                    onChange={(e) => setJobPreferences(e.target.value)}
                    rows={3}
                    maxLength={4000}
                    placeholder="E.g. Senior Product Manager roles — or: help me pivot away from web development; large established companies only."
                    aria-describedby={jobPreferencesHelpId}
                    // settingsFrozen is PERMANENT (roles locked on the first run,
                    // taking every setting below with them) — distinct from
                    // controlsLocked's transient "busy right now". Reusing the
                    // same disabled styling here is deliberate: it reads as
                    // intentionally locked, not merely temporarily busy.
                    disabled={controlsLocked || settingsFrozen}
                    className="w-full resize-y px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25 leading-snug disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  {/* One explanation for the whole frozen settings group, not a
                      per-control repeat: every setting below shares the same
                      lock and the same unlock path. */}
                  <span id={jobPreferencesHelpId} className="text-[9px] leading-snug text-white/25">
                    {settingsFrozen
                      ? 'All settings — brief, location, look-back window, search depth, and platforms — locked after your first search, so every re-scan is reproducible. Clear career data to unlock them and start over.'
                      : 'AI determines which roles to search from what you write here — explicit titles, a general direction, or nothing about roles at all. Tell it what to prioritize, avoid, or independently verify; “must,” “only,” and “no” are strict. Location, look-back window, search depth, and platforms are set by the controls below, not by this text.'}
                  </span>
                  {/* Trusting one AI decision for every future scan deserves to
                      be visible, not just implied by the disabled textarea. */}
                  {settingsFrozen && (
                    <p className="text-[9px] leading-snug text-emerald-300/55">
                      Locked roles: {resolvedRoles.join(', ')}
                    </p>
                  )}
                  {/* Most useful HERE, before the first run: a Reset that
                      retains a reusable career profile lands back in this
                      draft/empty state while keeping the locked plan (see
                      roleLockClearPatch), so a settingConflict caught now is
                      still fixable by clearing career files — after the
                      first run every setting it would point at is frozen. */}
                  <SearchBriefAdvisories searchBriefPlan={data.searchBriefPlan || null} />
                  {/* FIX 5: see titleOperatorAdvisory's header comment — the
                      resolved titles are what actually gets sent to job
                      boards verbatim, so this checks THEM, not the raw brief
                      text (which the AI may have transformed away from any
                      literal operator syntax it happened to contain). */}
                  {titleOperatorAdvisory(resolvedRoles)}
                </label>
                <JobSearchLocationFields
                  searchLocation={searchLocation}
                  setSearchLocation={setSearchLocation}
                  remoteResidences={remoteResidences}
                  setRemoteResidence={setRemoteResidence}
                  disabled={controlsLocked || settingsFrozen}
                />
                <label className="flex items-center justify-center gap-1.5">
                  <span>Look back</span>
                  <input
                    type="number"
                    data-native-undo="true"
                    min={1}
                    max={180}
                    value={maxAgeDays}
                    onChange={(e) => setMaxAgeDays(e.target.value)}
                    aria-label="Maximum posting age in days"
                    disabled={controlsLocked || settingsFrozen}
                    className="w-10 text-center bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span>days</span>
                </label>
                {!controlsLocked && (
                  <JobCollectionLimitsControl
                    collectionLimits={collectionLimits}
                    setCollectionLimits={setCollectionLimits}
                    disabled={settingsFrozen}
                  />
                )}
                {!controlsLocked && (
                  <JobPlatformSelectionControl
                    enabledSourceIds={enabledSourceIds}
                    setEnabledSourceIds={setEnabledSourceIds}
                    collectionLimits={collectionLimits}
                    availableSourceIds={ACTIVE_JOB_SOURCES}
                    searchLocation={searchLocation}
                    disabled={settingsFrozen}
                  />
                )}
                {savedAnalysisPanel}
              </div>}
            </div>
          </>
        )}

        {/* Processing state */}
        {isProcessing && (
          <JobSearchProcessingState
            statusLabel={statusLabel}
            hubState={hubState}
            totalSourceJobs={totalSourceJobs}
            scoringProgress={scoringProgress}
            resumeSummary={data.resumeSummary}
            activeSourceId={lastActiveSource}
            activeSourceDetail={sourceProgress[lastActiveSource]?.detail || null}
            onReset={resetHandler}
            chromeLaunchInfo={chromeLaunchInfo}
            queuedRun={data.queuedModuleRun || null}
          />
        )}

        {/* Paused on blocked sources — show the resolve/skip decision UI.
            Banner stays visible above (e.g. if a prior scoring attempt
            failed and we reverted here). */}
        {hubState === 'sources-ready' && (
          <>
            {banner}
            <JobSearchSourcesReadyState
              // Count DISTINCT blocked sources, not raw warnings: a source can
              // hit a captcha on several queries (indeed-0, indeed-1, …) and
              // store one warning each, but the canvas shows one card per
              // source — so counting warnings made it say "2 sources blocked"
              // with only one Indeed card visible. Skip/resolve already filters
              // warnings by sourceId, so distinct-source count is the truth.
              blockedCount={new Set((data.scrapeWarnings || []).filter(isJobSourceWarningGating).map(w => w.sourceId)).size}
              jobsAvailable={Array.isArray(data.pendingJobs) ? data.pendingJobs.length : (data.jobCount || 0)}
              resumeSummary={data.resumeSummary}
              locked={controlsLocked}
              // Only sources whose warning actually offers a recovery action can
              // be driven — a terminal hard block has nothing to Solve, so
              // promising to solve it would open a window that cannot help.
              solvableCount={new Set((data.scrapeWarnings || [])
                .filter(w => isJobSourceWarningGating(w) && canAttemptJobSourceResolve(w))
                .map(w => w.sourceId)).size}
              solveAllRunning={!!solveAllProgress}
              solveAllProgress={solveAllProgress}
              onSolveAll={activeBoardRecoveryOwnerKey && !pausedBoardContinuationOwnerKey
                ? null
                : handleSolveAllBlockedSources}
              onStopSolveAll={handleStopSolveAll}
              onScoreCurrent={activeBoardRecoveryOwnerKey && !pausedBoardContinuationOwnerKey
                ? null
                : handleScoreCurrentResults}
              onClearCareerFiles={activeBoardRecoveryOwnerKey ? null : handleClearCareerFiles}
            />
            {savedAnalysisPanel && (
              <div className="w-full px-3 pb-3" onPointerDown={(e) => e.stopPropagation()}>
                {savedAnalysisPanel}
              </div>
            )}
          </>
        )}

        {/* Done state — shows stale results + banner above when a re-run failed */}
        {hubState === 'done' && (
          <>
            {banner}
            <JobSearchDoneState
              resultCount={data.resultCount}
              scrapedCount={data.scrapedCount}
              gatheredCount={doneGatheredCount}
              queryModel={data.queryModel || null}
              testMode={!!data.testMode}
              aiSkipped={!!data.aiSkipped}
              collectionOnly={!!data.collectionOnly}
              resumeSummary={data.resumeSummary}
              locked={controlsLocked}
              platformsVerifying={platformsVerifying}
              verifyDone={verifyDone}
              verifyTotal={verifyTotal}
              managedByJobBoard={managedByJobBoard}
              boardRecoveryPending={!managedByJobBoard && !!activeBoardRecoveryOwnerKey}
              onRerun={boardRecoveryOwnsActions ? null : handleRerun}
              onReanalyze={boardRecoveryOwnsActions || data.terminalFinalizationRecovery ? null : handleReanalyze}
              onClearCareerFiles={activeBoardRecoveryOwnerKey ? null : handleClearCareerFiles}
              maxAgeDays={maxAgeDays}
              setMaxAgeDays={setMaxAgeDays}
              collectionLimits={collectionLimits}
              setCollectionLimits={setCollectionLimits}
              enabledSourceIds={enabledSourceIds}
              setEnabledSourceIds={setEnabledSourceIds}
              availableSourceIds={ACTIVE_JOB_SOURCES}
              searchLocation={searchLocation}
              setSearchLocation={setSearchLocation}
              remoteResidences={remoteResidences}
              setRemoteResidence={setRemoteResidence}
              jobPreferences={jobPreferences}
              setJobPreferences={setJobPreferences}
              resolvedRoles={resolvedRoles}
              // FIX 2: pass the lock sentinel itself, not just the displayed
              // list — see hasResolvedRoleLock above. Omitting this prop
              // silently reverts the done-state UI to "never locked" even
              // though the durable lock (and this component's own settings)
              // are frozen, letting the user edit controls a re-scan ignores.
              resolvedRolesMeta={data.resolvedRolesMeta || null}
              searchBriefPlan={data.searchBriefPlan || null}
              preferenceMatchedCount={data.preferenceMatchedCount}
              preferenceFilteredCount={data.preferenceFilteredCount}
              jobPreferencePlan={data.jobPreferencePlan || null}
              preferenceEvaluation={data.preferenceEvaluation || null}
              scrapeWarnings={data.scrapeWarnings || []}
              collectionScopeCaveats={data.collectionScopeCaveats || []}
              rerunOutcome={data.rerunOutcome || null}
              reanalysisNotice={data.reanalysisNotice || null}
              resultDisposition={data.resultDisposition || null}
              lastCompletedRunAt={data.lastCompletedRunAt || null}
            />
            {/* FIX 5: sibling to (never nested inside) JobSearchDoneState,
                which renders its own SearchBriefAdvisories internally —
                this file cannot add a slot to that child component, see
                titleOperatorAdvisory's header comment. */}
            <div className="w-full px-3" onPointerDown={(e) => e.stopPropagation()}>
              {titleOperatorAdvisory(resolvedRoles)}
            </div>
            {savedAnalysisPanel && (
              <div className="w-full px-3 pb-3" onPointerDown={(e) => e.stopPropagation()}>
                {savedAnalysisPanel}
              </div>
            )}
          </>
        )}
      </HubContainer>
  );
});
