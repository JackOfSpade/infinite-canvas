import { foldAppliedCheckInto } from '../../../src/utils/applicationBundleIdentity.js';
import { normalizeBands, normalizeRanges, parseSalaryToNumeric, placeBand, placeRange, salaryRangeAnomaly, salaryRangeMetadata, sanitizeJobTaxonomy } from '../../../src/nodes/jobsearch/buildJobTree.js';
import { HANDOFF_CONCURRENCY, mapAutomaticHandoffs } from '../../../src/utils/handoffScheduler.js';
import { isLegacyUnscoredPlaceholder, isUnscoredPlaceholderCard } from '../../../src/utils/jobCardFilters.js';
import { JOB_SCORING_CONTRACT } from '../../../src/utils/jobScoringContract.js';
import { JOB_SEARCH_TEST_MODE } from '../../../src/utils/jobSourceScope.js';
import { enrichDiceDescriptions } from '../../extractors/apiExtractors.js';
import { GLASSDOOR_CONFIG, GLASSDOOR_EXTRACTOR, GOOGLE_JOBS_CONFIG, GOOGLE_JOBS_EXTRACTOR, ZIPRECRUITER_CONFIG, ZIPRECRUITER_EXTRACTOR } from '../../extractors/jobs.js';
import { logger } from '../../logger.js';
import { JOB_COMPENSATION_EVIDENCE_BATCH_SCHEMA, JOB_LOCATION_RESOLUTION_SCHEMA, JOB_QUERY_GENERATION_SCHEMA, JOB_SCORING_SCHEMA, ROLE_FAMILY_EXPERIENCE_BANDS_BATCH_SCHEMA } from '../aiSchemas.js';
import { GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE } from '../browser/manualScraper.js';
import { CAREER_TRANSCRIPTION_POLICY_DIGEST } from '../careerSnapshot.js';
import { refreshDiceTeaserRows } from '../diceTeaserRefresh.js';
import { getCurrentIpcRequestContext, nodeCancellationError } from '../ipcUtils.js';
import { MAX_JOB_ANALYSIS_ARTIFACT_BYTES } from '../jobAnalysisArtifactLimits.js';
import { currentJobAnalysisOperationAuthority, jobAnalysisOperationAuthorityReceipt, withCurrentJobAnalysisOperationAuthority } from '../jobAnalysisOperationAuthorityStore.js';
import { buildScoredJob } from '../jobBatchReconcile.js';
import { summarizeFitCalibration } from '../jobFitAssessment.js';
import { JOB_GAP_REVIEW_BATCH_SIZE, JOB_GAP_REVIEW_SCHEMA, JOB_GAP_REVIEW_TASK, summarizeGapReviews } from '../jobGapReview.js';
import { confirmSimilarJobLocationPairs } from '../jobLocationConsolidation.js';
import { researchDeferredJobPreferences } from '../jobPreferences.js';
import { createJobScoreReuseStore, jobScoreReuseFingerprint, mergeReusedAndScored, partitionBatchForReuse } from '../jobScoreReuse.js';
import { buildJobScoringRequestParts } from '../jobScoringCache.js';
import { SOURCE_HEALTH_WARNING_CODE } from '../jobSourceHealth.js';
import { dedupAgainstHistory, finalizeDisplayedJobsHistory, stageDisplayedJobsHistory } from '../jobsHistory.js';
import { createListingLivenessProbe } from '../listingLivenessProbe.js';
import { recheckPendingListings } from '../listingLivenessRecheck.js';
import { createListingLivenessSearchSession } from '../listingLivenessSearch.js';
import { readListingEvidence } from '../listingLivenessStore.js';
import { callLLMRaw, callLLMText, checkPromptFits } from '../llm.js';
import { NON_API_AI_TRANSPORT, durableRunHasAnyTask } from '../nonApiAi.js';
import { officialPostingOutranksClosedPage } from '../officialPostingBoardClosed.js';
import { listingStateRank, normalizeListingLiveness, normalizeOfficialPosting, officialPostingLookupStatus } from '../officialPostingFields.js';
import { officialPostingDedup } from '../officialPostingService.js';
import { PERSONAL_SALARY_GUIDANCE_PROMPT, PERSONAL_SALARY_METHODOLOGY_VERSION } from '../personalSalaryRecommendation.js';
import { RESEARCH_ELIGIBILITY, classifyResearchEligibility, isResearchEligible, summarizeResearchEligibility } from '../researchGate.js';
import { JOB_SCORE_CAP, MAX_COMPENSATION_ROWS_PER_ASSESSMENT_COHORT, RESEARCH_MIN_FIT_SCORE } from '../resultCaps.js';
import { buildScoringAudit, scoringAuditRowsFromBatches } from '../scoringAudit.js';
import { CANCEL_CAUSE_LABELS, CHECKPOINT_PRESERVING_ABORT_CAUSES, JOB_ANALYSIS_SNAPSHOT_VERSION, JobOperationSupersededError, REANALYZE_SAVED_JOBS_RECOVERY_MODE, analysisPathsForCanvas, authorityReceiptMatches, classifySnapshotExactOwnership, isJobOperationSupersededError, jobAnalysisArtifactDigest, jobAnalysisSnapshotOwner, normalizeCareerSnapshotIdentifier, normalizeJobAnalysisIdentifier, readAnalysisArtifact, recordAnalysisRecoveryLifecycle, saveJobAnalysisSnapshot, scopedPublicationMatches, snapshotCreatedAtMs, snapshotOperationAuthority } from './analysisStore.js';
import { MAX_SCORING_CAREER_DATA_CHARS, PINNED_SCORING_EVIDENCE_MARKER, createScoringAttemptSignal, materializeScoringCareerEvidence } from './careerInput.js';
import { researchCompensationAssessments } from './compensationResearch.js';
import { JOB_BOARD_GENERATION_CAPABILITY, SCORING_HEARTBEAT_MS, UNSCORED_FALLBACK_SCORE, buildJobAnalysisSnapshot, inspectJobBoardRoleByIndex, invalidJobBoardTaxonomyError, mergeRecoveredScoreRows, normalizeJobBoardRoleByIndex, officialPostingConsumerJobs, officialPostingConsumerMap, planPartialScoreRecovery, prepareLiveScoringResults, rescoreMaterialOfficialText, restoreOfficialPostingConsumerIdentity, runGapReviewPass, scoreRowsOnCareerRecord, scoringPromptEnvelopeError, scoringPromptFitsEnvelope, validateJobBoardRoleTaxonomy, validateJobScoringSubmission } from './scoring.js';
import { ACTIVE_SOURCE_IDS, ACTIVE_SOURCE_ID_SET, ALL_SOURCE_IDS, BACKGROUND_PROVIDER_ONLY_SOURCE_IDS, BROWSER_SCRAPE_ORDER, EXACT_RESUME_PROVIDER_ONLY_SOURCE_IDS, JOB_DESCRIPTION_EVIDENCE_MIN_CHARS, JOB_SOURCE_DISPLAY_NAMES, WALK_GUARD_WARNING_CODE, hasResolvedJobDescription, summarizeScoringInputQuality } from './sourceRules.js';
import { JOB_BOARD_TELEMETRY_CAP, RECENT_INDEED_LOGIN_MS, getScopedJobsTelemetry, jobsTelemetry } from './state.js';
import { recordHistoryWrite, recordJobsBoardScope, recordJobsSourceScope, roleCoverage, rolesFromRoleByIndex, salaryContextFor } from './telemetry.js';
import crypto from 'crypto';
import path from 'path';

const HISTORY_TOKEN_TTL_MS = 5 * 60 * 1000;
const pendingHistoryWrites = new Map();

function canonicalHistoryRows(rows) {
  if (!Array.isArray(rows) || rows.length > 10000) return null;
  const normalized = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const out = {};
    for (const key of ['source', 'company', 'title', 'location', 'url']) {
      const value = typeof row[key] === 'string' ? row[key].replace(/\s+/g, ' ').trim() : '';
      if (value.length > 2000) return null;
      out[key] = value;
    }
    return out;
  });
  return normalized.some(row => row == null) ? null : normalized;
}

function historyRowsDigest(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function normalizeHistorySource(value) {
  const hubId = normalizeJobAnalysisIdentifier(value?.hubId || value?.nodeId);
  const runId = normalizeJobAnalysisIdentifier(value?.runId);
  const careerSnapshotId = normalizeCareerSnapshotIdentifier(value?.careerSnapshotId);
  const authority = jobAnalysisOperationAuthorityReceipt(value?.operationAuthority);
  if (!hubId || !runId || !careerSnapshotId || !authority
    || authority.semanticBase?.careerSnapshotId !== careerSnapshotId
    || (authority.semanticBase?.runId != null && authority.semanticBase.runId !== runId)) return null;
  return { hubId, runId, careerSnapshotId, authority };
}

function purgeExpiredHistoryTokens(now = Date.now()) {
  for (const [token, value] of pendingHistoryWrites) {
    if (!value || value.expiresAt <= now) pendingHistoryWrites.delete(token);
  }
}

async function withHistorySourceAuthorities(canvasFilePath, sources, callback, index = 0, records = []) {
  if (index >= sources.length) return callback(records);
  const source = sources[index];
  return withCurrentJobAnalysisOperationAuthority({
    // A clean Job Search terminal receipt intentionally tombstones its write
    // capability after sealing the snapshot. Board history is read-only over
    // those sealed bytes, so admit that exact revoked receipt but still reject
    // any successor/clear record.
    canvasFilePath, hubId: source.hubId, ...source.authority, allowRevoked: true,
  }, async record => {
    const inner = await withHistorySourceAuthorities(canvasFilePath, sources, callback, index + 1, [...records, record]);
    // Each nested durable admission normally wraps its callback value. Carry
    // only that final value outward; a failed inner source becomes null while
    // every already-acquired outer lock remains held until this callback exits.
    return index + 1 < sources.length
      ? { value: inner?.admitted ? inner.value : null }
      : inner;
  });
}

// A continuation claim (resume-saved-scrape and its siblings) rebinds the
// current operation WITHOUT republishing the bytes it resumed: the authority
// claim carries `publications` forward, so the sealed snapshot still embeds the
// earlier operation's receipt. Board display is read-only over those exact
// bytes, so admit that adoption when the continuation, its run, its career, and
// the published generation digest all still agree. These are the same
// continuation kinds the authority store treats as lineage operations.
const BOARD_HISTORY_ADOPTED_KINDS = new Set([
  'resume-saved-scrape', 'crash-resume', 'resolved-source-continuation',
]);

function historyAdoptionEligible(source, snapshotAuthority) {
  const current = source?.authority?.semanticBase;
  const sealedReceipt = snapshotAuthority?.semanticBase;
  return !!current && !!sealedReceipt
    && BOARD_HISTORY_ADOPTED_KINDS.has(current.kind)
    && current.runId != null && current.runId === source.runId
    && current.careerSnapshotId === source.careerSnapshotId
    && sealedReceipt.runId === source.runId
    && sealedReceipt.careerSnapshotId === source.careerSnapshotId;
}

// Fixed kebab-case codes only: a rejection must never leak ids, paths, or job
// content into a log line or support report.
function historySourceRejectionReason({ source, snapshotAuthority, receiptMatches }) {
  if (!snapshotAuthority) return 'snapshot-authority-mismatch';
  if (receiptMatches) return 'publication-mismatch';
  // Adoption stopped somewhere other than the byte check (kind/run/career), so
  // the receipt itself was the mismatch; otherwise the sealed bytes are no
  // longer the generation the record published for this run.
  return historyAdoptionEligible(source, snapshotAuthority) ? 'publication-mismatch' : 'snapshot-authority-mismatch';
}

async function verifySealedHistorySources(canvasFilePath, sources, records, displayedRows = []) {
  const sealed = [];
  const reject = reason => ({ sealed: null, reason });
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const paths = analysisPathsForCanvas(canvasFilePath, null, source.hubId);
    const read = await readAnalysisArtifact(paths.jsonPath);
    if (read.state !== 'present') return reject('snapshot-absent');
    const snapshot = read.snapshot;
    if (classifySnapshotExactOwnership(snapshot, canvasFilePath, source.hubId) !== 'owned') return reject('snapshot-not-owned');
    if (normalizeJobAnalysisIdentifier(snapshot?.runId) !== source.runId) return reject('run-mismatch');
    if (snapshot?.careerSnapshotId !== source.careerSnapshotId) return reject('career-mismatch');
    const snapshotAuthority = snapshotOperationAuthority(snapshot);
    const receiptMatches = authorityReceiptMatches(snapshotAuthority, source.authority);
    const exact = receiptMatches
      && scopedPublicationMatches(records[index], 'current', read.serialized, source.authority);
    const adopted = !exact && historyAdoptionEligible(source, snapshotAuthority)
      && scopedPublicationMatches(records[index], 'current', read.serialized, snapshotAuthority);
    if (!exact && !adopted) {
      return reject(historySourceRejectionReason({ source, snapshotAuthority, receiptMatches }));
    }
    // The source artifact is saved before scoring, so its rows normally carry
    // no score. It proves a displayed row belongs to this source; the Board
    // sends only rows it has a real score for. Its frozen preference status is
    // ignored: Board preferences can show a row the Search filtered, and what
    // the Board displayed is what limits staging below.
    // One malformed candidate the Board never showed must not block the display.
    const scoredRows = (snapshot.jobs || []).filter(job => job && typeof job === 'object'
      && (job.matchScore == null || (Number.isFinite(job.matchScore) && job.matchScore >= 0 && job.matchScore <= 100))
      && !isUnscoredPlaceholderCard(job) && !isLegacyUnscoredPlaceholder(job)).flatMap(job => (
      Array.isArray(job.postingVariants) && job.postingVariants.length
        ? job.postingVariants.map(variant => ({ source: variant.source || job.source, company: job.company,
          title: job.title, location: variant.location || job.location, url: variant.url || job.url }))
        : [job]
    )).flatMap(row => canonicalHistoryRows([row]) || []);
    const notDisplayed = new Set(dedupAgainstHistory(scoredRows, displayedRows).kept);
    sealed.push({ ...source, artifactFingerprint: jobAnalysisArtifactDigest(read.serialized),
      displayedRows: scoredRows.filter(row => !notDisplayed.has(row)) });
  }
  return { sealed, reason: null };
}

// Multi-source admission nests one `{ value }` wrapper per additional source,
// while a single source returns its value directly. Unwrap both shapes so the
// callers always see the innermost verification/staging object.
function historyAdmissionValue(value) {
  let current = value;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!current || typeof current !== 'object') return null;
    if (current.value !== undefined && !('sealed' in current) && !('historyStage' in current)
      && !('historyFailure' in current)) {
      current = current.value;
      continue;
    }
    return current;
  }
  return null;
}

async function prepareBoardHistoryWrite(event, { canvasFilePath, jobs, sources } = {}) {
  const rows = canonicalHistoryRows(jobs);
  const normalizedSources = Array.isArray(sources) ? sources.map(normalizeHistorySource) : [];
  if (!canvasFilePath || !rows || normalizedSources.length === 0 || normalizedSources.some(source => !source)) {
    return { success: false, operationSuperseded: true, reason: 'missing-authority',
      error: 'Missing exact Board history authority.' };
  }
  normalizedSources.sort((a, b) => a.hubId.localeCompare(b.hubId));
  if (new Set(normalizedSources.map(source => source.hubId)).size !== normalizedSources.length) {
    return { success: false, operationSuperseded: true, reason: 'ambiguous-sources',
      error: 'Ambiguous Board history sources.' };
  }
  const admission = await withHistorySourceAuthorities(canvasFilePath, normalizedSources,
    records => verifySealedHistorySources(canvasFilePath, normalizedSources, records, rows));
  const verified = admission?.admitted && admission.value && typeof admission.value === 'object'
    ? historyAdmissionValue(admission.value)
    : null;
  const sealed = Array.isArray(verified?.sealed) ? verified.sealed : null;
  if (!sealed) {
    return {
      success: false,
      operationSuperseded: true,
      reason: !admission?.admitted || !verified ? 'authority-not-current' : (verified.reason || 'publication-mismatch'),
      error: 'Board inputs were superseded before display commit.',
    };
  }
  purgeExpiredHistoryTokens();
  const token = crypto.randomUUID();
  pendingHistoryWrites.set(token, {
    senderId: event.sender?.id || null,
    canvasFilePath: path.resolve(canvasFilePath),
    rowsDigest: historyRowsDigest(rows),
    sources: sealed,
    expiresAt: Date.now() + HISTORY_TOKEN_TTL_MS,
    inFlight: false,
  });
  return { success: true, historyToken: token, rowsDigest: historyRowsDigest(rows) };
}

async function consumeBoardHistoryWrite(event, { canvasFilePath, jobs, historyToken } = {}) {
  purgeExpiredHistoryTokens();
  const token = typeof historyToken === 'string' ? historyToken : '';
  const entry = pendingHistoryWrites.get(token);
  const rows = canonicalHistoryRows(jobs);
  if (!entry || entry.inFlight || !rows || !canvasFilePath
    || path.resolve(canvasFilePath) !== entry.canvasFilePath
    || entry.senderId !== (event.sender?.id || null)
    || historyRowsDigest(rows) !== entry.rowsDigest) {
    return { success: false, operationSuperseded: true, reason: 'history-token-invalid',
      error: 'Board history commit was not authorized.' };
  }
  entry.inFlight = true;
  try {
    const admission = await withHistorySourceAuthorities(entry.canvasFilePath, entry.sources, async records => {
      const verified = await verifySealedHistorySources(entry.canvasFilePath, entry.sources, records, rows);
      const sealed = Array.isArray(verified?.sealed) ? verified.sealed : null;
      if (!sealed) return { historyFailure: verified?.reason || 'artifact-changed' };
      if (sealed.some((source, index) => source.artifactFingerprint !== entry.sources[index]?.artifactFingerprint)) {
        return { historyFailure: 'artifact-changed' };
      }
      // Stage while the exact source locks are still held. A fresh scrape
      // cannot finalize the old generation and then admit a late display.
      return {
        historyStage: await stageDisplayedJobsHistory(entry.canvasFilePath,
          sealed.map(source => ({ hubId: source.hubId, runId: source.runId, rows: source.displayedRows }))),
      };
    });
    const settled = admission?.admitted && admission.value && typeof admission.value === 'object'
      ? historyAdmissionValue(admission.value)
      : null;
    if (!settled || settled.historyFailure || !settled.historyStage) {
      return {
        success: false,
        operationSuperseded: true,
        reason: admission?.admitted ? (settled?.historyFailure || 'artifact-changed') : 'authority-not-current',
        error: 'Board inputs changed before history commit.',
      };
    }
    const result = settled.historyStage;
    pendingHistoryWrites.delete(token);
    return result;
  } finally {
    // A write error leaves the same exact capability retryable until expiry;
    // staging itself is idempotent at listing-key level.
    if (pendingHistoryWrites.get(token) === entry) entry.inFlight = false;
  }
}

export const __boardHistoryAuthorityForTests = {
  prepare: prepareBoardHistoryWrite,
  consume: consumeBoardHistoryWrite,
  pendingCount: () => pendingHistoryWrites.size,
};

export function registerBoardHandlers(ctx) {
  const { dependencies, handleSafe, resolvePinnedScoringInputForHandler, beforeScoreSideEffect, runScoreBatch, reuseStoreDeps, runGapReview, runBoardTaxonomy, resolveBoardCompensationCareerInputs, callListingLiveness, listingLivenessCalibrationStore, settleBoardClosedRowsForHandler } = ctx;
  // ── Jobs history (60-day rolling CSV next to the canvas JSON) ─────────────
  handleSafe('prepare-board-jobs-history', async (event, args = {}) => prepareBoardHistoryWrite(event, args));

  // Called only by the committed Job Search deletion path. Board/tree/card
  // removal never crosses this boundary, and callers cannot supply rows.
  handleSafe('finalize-displayed-job-history', async (_event, { canvasFilePath, nodeId } = {}) => {
    if (!canvasFilePath || !normalizeJobAnalysisIdentifier(nodeId)) return { success: false, error: 'Missing Job Search history owner.' };
    return finalizeDisplayedJobsHistory(canvasFilePath, nodeId, { deleted: true });
  });

  handleSafe('append-jobs-history', async (event, { canvasFilePath, jobs, nodeId, historyStage, historyToken = null } = {}) => {
    const telemetry = getScopedJobsTelemetry(); // pin this Board before the authority/write awaits
    // A Board may write only after the renderer has committed its cards. The
    // host-issued one-shot token binds those rows to the exact sealed source
    // artifacts it checked before that UI commit; arbitrary renderer rows can
    // no longer stage history ahead of display. Display receipts remain
    // provisional until source deletion or the source's next scrape.
    const result = historyStage === 'boardDisplay'
      ? await consumeBoardHistoryWrite(event, { canvasFilePath, jobs, historyToken })
      : { success: false, operationSuperseded: true, error: 'History writes require a Board display receipt.' };
    // The board caller is deliberately awaited after it has added result cards.
    // Keep board-owned telemetry separate from the source search's identity.
    if (nodeId && nodeId === telemetry.boardNodeId && historyStage === 'boardDisplay') {
      recordHistoryWrite('boardDisplay', jobs, result);
    }
    return result;
  });

  // ── Score Jobs Against Resume ─────────────────────────────────────────────
  handleSafe('score-jobs', async (event, { jobs, profile, careerData, careerSnapshotId, nodeId, jobPreferences, jobPreferencePlan, preferenceEvaluation, preferenceCandidatePool, operationAuthority, snapshotContext, manualAiRecoveryMode, manualAiRunId } = {}, signal) => {
    const analysisRevisionId = manualAiRecoveryMode === REANALYZE_SAVED_JOBS_RECOVERY_MODE
      ? normalizeJobAnalysisIdentifier(snapshotContext?.analysisRevisionId)
        || normalizeJobAnalysisIdentifier(manualAiRunId)
      : null;
    const scoringAuthority = jobAnalysisOperationAuthorityReceipt(operationAuthority);
    // No scorer/handoff may start on a renderer-only or superseded capability.
    // A later save check is necessary too, but it cannot undo an expensive
    // manual task already dispatched under stale career evidence.
    if (!scoringAuthority || scoringAuthority.semanticBase.careerSnapshotId !== careerSnapshotId
      || !nodeId || !await currentJobAnalysisOperationAuthority({ canvasFilePath: snapshotContext?.canvasFilePath, hubId: nodeId, ...scoringAuthority })) {
      return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before scoring started.' };
    }
    // A snapshot id is an authority boundary, not display metadata.  Never
    // score a renderer-provided raw upload after that id exists: re-read the
    // immutable approved record and use only its approved projection.  Legacy
    // calls without an id keep the historical bounded raw-text path below.
    const pinnedScoringInput = await resolvePinnedScoringInputForHandler({ careerSnapshotId, profile, careerData });
    const scoringIsCurrent = async () => currentJobAnalysisOperationAuthority({
      canvasFilePath: snapshotContext?.canvasFilePath,
      hubId: nodeId,
      ...scoringAuthority,
    });
    let scoringSuperseded = false;
    const assertScoringCurrent = async () => {
      if (await scoringIsCurrent()) return;
      scoringSuperseded = true;
      throw new JobOperationSupersededError();
    };
    // The immutable projection read is an await boundary.  A newer operation
    // may claim the hub while it is being read, so do not even paint telemetry
    // or build a recoverable snapshot from the old projection afterwards.
    if (!await scoringIsCurrent()) {
      return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded while its pinned snapshot was being read.' };
    }
    await beforeScoreSideEffect({ phase: 'after-pinned-scoring-input', nodeId, careerSnapshotId, operationAuthority: scoringAuthority });
    if (!await scoringIsCurrent()) {
      return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before scoring side effects.' };
    }
    const scoringProfile = pinnedScoringInput.profile;
    const scoringCareerData = pinnedScoringInput.careerData;
    // Scoring reads the scraped listing. A row already holding an official
    // posting from an older run keeps that view, so its accepted batches replay.
    // Older retryable lookups and pending listings wait for the Board's research
    // stage, which takes them only at or above the threshold.
    const rawScoringJobs = Array.isArray(jobs) ? jobs : [];
    // A direct re-score (e.g. the Board's saved-job scoring) skips the search
    // pipeline, so Dice rows still carry the list API's short teaser. Refresh
    // them before the official-posting map and scoring run.
    const diceRefresh = await refreshDiceTeaserRows(rawScoringJobs, { enrich: enrichDiceDescriptions, signal });
    const scoringJobs = diceRefresh.jobs;
    if (diceRefresh.attempted > 0) {
      logger.info(`[Jobs][${nodeId}] Refreshed ${diceRefresh.attempted} Dice teaser description(s) before scoring: ${diceRefresh.lengthened} lengthened`);
    }
    await assertScoringCurrent();
    if (jobsTelemetry.search?.runId === snapshotContext?.runId) {
      jobsTelemetry.search.officialLookupsIncomplete = scoringJobs.filter(job => job?.officialPosting
        && officialPostingLookupStatus(job.officialPosting).retryable).length;
    }
    const postingJob = await officialPostingConsumerMap(scoringJobs);
    await assertScoringCurrent();
    const { role, gathered, toScore, cappedForBudget, scoringBatches, slimBatch, cachedPrefix: snapshotCachedPrefix, snapshot } =
      buildJobAnalysisSnapshot({
        jobs: scoringJobs, postingJob, profile: scoringProfile, careerData: scoringCareerData, careerSnapshotId, approvedScoringSnapshot: pinnedScoringInput.pinned, nodeId, jobPreferences, jobPreferencePlan, preferenceEvaluation, preferenceCandidatePool, operationAuthority,
        snapshotContext: manualAiRecoveryMode
          ? {
            ...(snapshotContext || {}),
            recoveryMode: manualAiRecoveryMode,
            ...(analysisRevisionId ? { analysisRevisionId } : {}),
          }
          : snapshotContext,
      });
    // Use the same bounded primary evidence sent to the model, with the
    // structured profile retained as a legacy fallback. This lets the
    // deterministic auditor reject citations that were not actually available
    // to the scorer, while preserving direct profile-only score requests.
    const candidateFitText = snapshot.careerData || JSON.stringify(scoringProfile || {});
    const candidateRoles = Array.isArray(scoringProfile?.workHistory) ? scoringProfile.workHistory : [];
    // Score each job against the entire approved record. Splitting jobs handles
    // batch breadth; a singleton that cannot fit stays visibly unscored.
    const cachedPrefix = materializeScoringCareerEvidence(snapshotCachedPrefix, snapshot.careerData);
    // A resumed run (same manualAiRunId) reuses the saved score rows of jobs
    // whose scoring input is byte-identical and scores only the rest (see
    // jobScoreReuse.js). Without a run id there is no scope to save rows under,
    // so every job scores exactly as before.
    const reuseRunId = getCurrentIpcRequestContext()?.manualAiRunId
      || (typeof manualAiRunId === 'string' && manualAiRunId.trim())
      || null;
    const reuseStore = createJobScoreReuseStore({
      runId: reuseRunId,
      recall: reuseStoreDeps.recall,
      remember: reuseStoreDeps.remember,
    });
    await reuseStore.load();

    const inputQuality = summarizeScoringInputQuality(toScore);
    logger.info(`[Jobs][${nodeId}] Scoring`, gathered.length, 'jobs', role ? `(target: ${role})` : '');
    // A direct re-score can enter without a fresh search-jobs call. Do not let
    // another hub's durable-history outcome ride along with that new telemetry.
    if (nodeId && jobsTelemetry.nodeId && jobsTelemetry.nodeId !== nodeId) jobsTelemetry.history = null;
    recordJobsSourceScope(nodeId, event.sender?.id ?? null);
    jobsTelemetry.scoringHeartbeat = {
      ts: Date.now(),
      active: true,
      // Job scoring is unconditionally the manual copy/paste handoff now — this
      // label is a fixed constant, not a per-run resolution. (bugReport's
      // jobsSnapshot.js keys off this exact string for its cancellation report.)
      transport: 'manual-ai-handoff',
      phase: 'preparing',
      scored: 0,
      total: toScore.length,
      batch: 0,
      batchTotal: scoringBatches.length,
      attemptSize: null,
      recoveryMode: manualAiRecoveryMode || null,
      analysisRevisionId,
      snapshotCreatedAtMs: snapshotCreatedAtMs(snapshot),
    };
    if (cappedForBudget > 0) {
      logger.info(`[Jobs][${nodeId}] Pre-rank cap: ${gathered.length} gathered → scoring top ${toScore.length} across sources (${cappedForBudget} lower-priority overflow not scored)`);
    }

    const scoredJobs = [];
    // Telemetry: a job is a "placeholder" when it was emitted with a default
    // matchScore (50) because its batch's LLM call failed or its one-shot
    // unresolved-row recovery still could not return an evidence-valid score —
    // i.e. the job was NOT genuinely analyzed. Tracking
    // this lets the bug report distinguish "15 real scores" from "15 scored,
    // 4 of them filler", which the `Scored N jobs` log line alone hides.
    let placeholderCount = 0;
    // Fresh provider rows that pass JSON Schema but omit meaningful grounded
    // requirement coverage are deliberately converted into placeholders.
    // Keep this separate from transport failures for diagnostics.
    let ungroundedScoreCount = 0;
    // Saved rows this resumed run reused instead of spending a handoff on the
    // jobs they already describe (see jobScoreReuse.js).
    let reusedScoreCount = 0;
    let failedBatches = 0;
    let batches = 0;
    // Top-level batches can wait on independent manual handoffs together.
    // `scoredJobs` remains assembled in source order after they settle, so
    // progress needs its own completed-job counter.
    let completedScoringJobCount = 0;
    // `batches` counts top-level UI work units. A structurally partial response
    // can trigger one targeted provider call for only its unresolved rows, so
    // provider-call accounting must be separate or diagnostics misleadingly
    // imply the run was one-call-per-batch.
    let providerCalls = 0;
    let partialRecoveryCalls = 0;
    let partialRecoveryRowAttempts = 0;
    // One accepted-progress scope for the whole scoring pass. Recursive
    // split/recovery attempts retain their top-level batch unit below, so a
    // single accepted batch cannot advance the display more than once.
    const scoringProgressScopeId = crypto.randomUUID();
    // Count only rows that pass the same calibration used for live cards.
    // The first scoring submission is deliberately permissive: an indexed but
    // evidence-invalid row will be retried in the targeted recovery, so it is
    // not progress yet. Split children and that recovery share their parent
    // progress unit; the transport caps their summed contributions at it.
    const measureUsableScoreProgressUnits = (value, batch) => {
      const submittedScores = Array.isArray(value?.scores)
        ? value.scores
        : Array.isArray(value)
          ? value
          : null;
      const responsePlan = planPartialScoreRecovery(submittedScores, batch.length);
      if (!responsePlan.usable) return 0;
      return prepareLiveScoringResults(responsePlan.alignedScores, batch.map(postingJob), {
        candidateText: candidateFitText,
        candidateRoles,
      }).scores.filter(Boolean).length;
    };
    // First batch-failure reason (e.g. "AI prompt too large (…chars)"), persisted
    // into telemetry so the bug report shows WHY a batch failed even after the raw
    // log line has scrolled out of the main-process ring buffer.
    let lastFailureReason = null;
    const scoringModels = new Set(); // distinct models that served the score batches
    // Always stays empty on the manual-handoff transport (there is no model
    // cascade to fall back through), kept only so the FULL report's rendering
    // shape doesn't have to special-case an absent field.
    const scoringFallbacks = [];
    try {
      if (!await scoringIsCurrent()) {
        scoringSuperseded = true;
        return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before recovery telemetry could be recorded.' };
      }
      const paths = await saveJobAnalysisSnapshot(snapshot);
      await assertScoringCurrent();
      if (paths.retired) {
        // Clear career files may arrive after this IPC started but before its
        // snapshot write acquired the lock. The renderer cancellation epoch
        // owns stopping the corresponding UI work; do not claim this stale
        // scorer durably saved career evidence in the meantime.
        logger.info(`[Jobs][${nodeId}] Ignored AI prompt snapshot for retired run ${snapshot.runId || 'unknown'}`);
        return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before scoring could be committed.' };
      } else {
        logger.info(`[Jobs][${nodeId}] Saved AI prompt snapshot to ${paths.jsonPath}`);
      }
    } catch (err) {
      if (isJobOperationSupersededError(err)) {
        return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before scoring could be committed.' };
      }
      logger.warn(`[Jobs][${nodeId}] Failed to save AI prompt snapshot:`, err);
    }

    // Score one batch → array aligned 1:1 with `batch`, each entry the job's
    // score object or null if it couldn't be scored. On a HARD batch failure
    // (transient provider error, or a pathologically large single job) we SPLIT
    // the batch and retry the halves rather than letting one bad job sink all of
    // them into filler scores — only a single job that still fails ends up null.
    // With the model's full input window available this split path is a
    // rarely-needed safety net (transient errors), not the norm.
    const scoreBatch = async (batch, context = {}) => {
      const activeCandidateText = context.candidateText ?? candidateFitText;
      const activeCachedPrefix = context.cachedPrefix ?? cachedPrefix;
      // Decide the prefix split from the normal top-level batch count, not
      // this attempt's (possibly split/recovery) size. A single-batch run
      // merges the rubric into one paste; a multi-batch run keeps it split so
      // every batch's handoff repeats the identical boilerplate a human can
      // recognize (see jobScoringCache.js) — not to protect a provider cache,
      // since every scoring call is a manual copy/paste handoff now.
      const requestParts = buildJobScoringRequestParts(
        `JOBS TO SCORE (array, indexed):\n${JSON.stringify(slimBatch(batch))}`,
        activeCachedPrefix,
        scoringBatches.length,
      );
      const envelope = scoringPromptFitsEnvelope(requestParts);
      // PROACTIVE context-window preflight: if this batch's prompt won't fit
      // what Claude can accept, split it in HALF and score the halves
      // independently BEFORE spending a doomed call. The recursion bottoms out
      // at one job.
      // Run the preflight for EVERY batch size, including a single-job batch
      // that could never be split by it. This await is the ONLY suspension
      // point between the Promise.all dispatch below and the handoff actually
      // being issued (requestNonApiAi is synchronous — it sends its IPC inside
      // the Promise executor). Gating it on `batch.length > 1` therefore let a
      // 1-job batch skip a microtask turn and jump the manual-handoff queue:
      // a historical 61-job run presented as 5, 1, 2, 3, 4. Keeping it
      // unconditional makes every batch reach the renderer after the same
      // number of turns, so the queue stays in batch order.
      let fit = null;
      try {
        await assertScoringCurrent();
        fit = await checkPromptFits(requestParts.prompt, { signal, task: 'job-scoring', hints: { itemCount: batch.length }, responseSchema: JOB_SCORING_SCHEMA, cachedPrefix: requestParts.cachedPrefix });
        await assertScoringCurrent();
      } catch (error) {
        if (isJobOperationSupersededError(error)) throw error;
        // Best-effort: a preflight hiccup must not block scoring — the reactive
        // split below still catches a real overflow.
      }
      // The local envelope is an independent hard safety check. It follows the
      // unconditional preflight so every scoring batch takes the same initial
      // async turn before it can issue a manual handoff. Split children must be
      // serial: one root slot must never fan into two concurrent handoffs.
      if (!envelope.fits) {
        if (batch.length > 1) {
          const mid = Math.ceil(batch.length / 2);
          const left = await scoreBatch(batch.slice(0, mid), context);
          const right = await scoreBatch(batch.slice(mid), context);
          return [...left, ...right];
        }
        // A single pathological listing cannot be made safe by dropping
        // approved career evidence or silently truncating the job. Keep its
        // normal unscored placeholder while every other job/page continues.
        const tooLarge = scoringPromptEnvelopeError(envelope.bytes).message;
        logger.warn(`[Jobs] ${tooLarge} Leaving this one job unscored.`);
        lastFailureReason = tooLarge;
        return [null];
      }
      // Splitting still requires more than one job. At length 1 `mid` is 1, the
      // right half is empty, and scoreBatch would recurse on the identical
      // batch forever. A single job that genuinely cannot fit must fall through
      // to the call, which refuses it with a clear error before any request.
      if (fit && !fit.fits && batch.length > 1) {
        logger.info(`[Jobs][${nodeId}] Window preflight: batch of ${batch.length} = ~${fit.tokens} tok > ${fit.budget} budget — splitting`);
        emitScoringProgress(completedScoringJobCount, {
          phase: 'splitting', batch: context.topLevelBatch, attemptSize: batch.length,
          detail: 'context-window',
        });
        const mid = Math.ceil(batch.length / 2);
        const [left, right] = [
          await scoreBatch(batch.slice(0, mid), context),
          await scoreBatch(batch.slice(mid), context),
        ];
        return [...left, ...right];
      }
      const batchMeta = {};
      let batchResult = null;
      const attempt = createScoringAttemptSignal(signal);
      const progressDetails = {
        // Preserve the recovery state throughout its model call and heartbeats;
        // otherwise the recursive call immediately replaces the more useful
        // status with the generic `running` phase.
        phase: context.partialRecovery ? 'recovering-missing-rows' : 'running',
        batch: context.topLevelBatch, attemptSize: batch.length,
        rootBatchSize: context.rootBatchSize || batch.length,
      };
      await assertScoringCurrent();
      emitScoringProgress(completedScoringJobCount, progressDetails);
      // A streamed response may have no completed jobs to report for minutes.
      // Keep both UI context and the bug-report task liveness current without
      // inflating the completed counter.
      let heartbeatLive = true;
      const heartbeat = setInterval(() => {
        void assertScoringCurrent().then(() => {
          if (heartbeatLive) emitScoringProgress(completedScoringJobCount, { ...progressDetails, heartbeat: true });
        }).catch(() => {});
      }, SCORING_HEARTBEAT_MS);
      try {
        providerCalls += 1;
        if (context.partialRecovery) {
          partialRecoveryCalls += 1;
          partialRecoveryRowAttempts += batch.length;
        }
        await assertScoringCurrent();
        await beforeScoreSideEffect({ phase: 'before-score-dispatch', nodeId, careerSnapshotId, operationAuthority: scoringAuthority, batch });
        await assertScoringCurrent();
        batchResult = await runScoreBatch(
          requestParts.prompt,
          {
            signal: attempt.signal,
            task: 'job-scoring',
            // Preserve the original top-level handoff identity through any
            // defensive split/recovery recursion. The dialog can therefore
            // tell the person exactly which normal scoring batch they are
            // answering, even if this attempt's row count became smaller.
            hints: {
              itemCount: batch.length,
              batch: context.topLevelBatch,
              batchTotal: scoringBatches.length,
              // Each top-level batch pauses at an async preflight before it
              // registers its handoff. A later batch can therefore reach the
              // dialog first; a planned prefix here would briefly claim work
              // finished before any paste succeeded. The shared scope owns
              // accepted progress, so zero is the truthful common baseline.
              itemsDone: 0,
              itemsTotal: scoringBatches.reduce((total, rows) => total + rows.length, 0),
              progressScopeId: scoringProgressScopeId,
              progressUnitId: `batch:${context.topLevelBatch}`,
              progressUnits: context.rootBatchSize || batch.length,
              attemptKind: context.partialRecovery
                ? 'partial-recovery'
                : batch.length < (context.rootBatchSize || batch.length) ? 'split' : 'initial',
              rootBatchSize: context.rootBatchSize || batch.length,
            },
            responseSchema: JOB_SCORING_SCHEMA,
            cachedPrefix: requestParts.cachedPrefix,
            meta: batchMeta,
            // The first manual handoff may be incomplete: accepting its valid
            // subset lets scoreBatch open one small, targeted recovery prompt.
            // That recovery handoff is strict and remains pending until every
            // requested row is grounded, so raw invalid scores never reach a
            // card and a long packed answer never has to be regenerated.
            responseValidator: (value) => validateJobScoringSubmission(value, batch.map(postingJob), {
              candidateText: activeCandidateText,
              candidateRoles,
              requireComplete: !!context.partialRecovery,
            }),
            measureProgressUnits: value => measureUsableScoreProgressUnits(value, batch),
            // This caller can divide work safely. Surface MAX_TOKENS to the
            // recursive split below instead of re-sending the same batch at a
            // larger cap and leaving every later job at 0/M.
            retryOnTruncation: false,
          },
        );
        await assertScoringCurrent();
        if (batchMeta.model) scoringModels.add(batchMeta.model);
        if (batchMeta.model && batchMeta.fallback?.attempts > 0) {
          scoringFallbacks.push({
            servedModel: batchMeta.model,
            ...batchMeta.fallback,
            counts: { ...(batchMeta.fallback.counts || {}) },
          });
        }
      } catch (err) {
        if (isJobOperationSupersededError(err) || signal?.aborted) throw err;
        // Provider SDKs may replace an AbortSignal's reason with a generic
        // AbortError. Restore our deadline error so telemetry and split logs name
        // the actual timeout rather than an unexplained cancellation.
        const attemptError = attempt.signal.reason?.code === 'SCORING_ATTEMPT_TIMEOUT'
          ? attempt.signal.reason
          : err;
        if (!lastFailureReason) lastFailureReason = attemptError?.message || String(attemptError);
        const reason = attemptError?.code === 'MAX_TOKENS'
          ? 'output cap reached; splitting immediately'
          : attemptError?.code === 'SCORING_ATTEMPT_TIMEOUT'
            ? 'attempt timed out; splitting'
            : attemptError?.message || attemptError;
        logger.warn(`[Jobs] Batch scoring failed (size ${batch.length}; ${reason}):`, attemptError?.message || attemptError);
        batchResult = null;
      } finally {
        heartbeatLive = false;
        clearInterval(heartbeat);
        attempt.cleanup();
      }
      // Accept the wrapped { scores: [...] } shape (schema-enforced) or a bare
      // array (older format) so we're robust if a provider returns the legacy shape.
      const scores = Array.isArray(batchResult?.scores)
        ? batchResult.scores
        : Array.isArray(batchResult)
          ? batchResult
          : null;
      if (scores) {
        const responsePlan = planPartialScoreRecovery(scores, batch.length);
        if (responsePlan.usable) {
          // Valid provider responses can omit a row or return one that fails
          // evidence calibration. Retry only that final null/invalid subset
          // once; slimBatch reindexes it from zero, then recovered rows are
          // merged back into their original positions. Do not recursively
          // recover partial recoveries: unresolved rows remain visible
          // placeholders after this bounded pass.
          const initialLiveResults = prepareLiveScoringResults(
            responsePlan.alignedScores,
            batch.map(postingJob),
            { candidateText: activeCandidateText, candidateRoles },
          );
          const recoveryIndices = initialLiveResults.scores.reduce((indices, score, index) => {
            if (!score) indices.push(index);
            return indices;
          }, []);
          if (recoveryIndices.length > 0 && !context.partialRecovery) {
            const missingJobs = recoveryIndices.map(index => batch[index]);
            emitScoringProgress(completedScoringJobCount, {
              phase: 'recovering-missing-rows',
              batch: context.topLevelBatch,
              attemptSize: missingJobs.length,
              rootBatchSize: context.rootBatchSize || batch.length,
              detail: 'partial-response',
            });
            const recovered = await scoreBatch(missingJobs, { ...context, partialRecovery: true });
            return mergeRecoveredScoreRows(
              responsePlan.alignedScores,
              recoveryIndices,
              recovered,
            );
          }
          return responsePlan.alignedScores;
        }
      }
      if (batch.length > 1) {
        emitScoringProgress(completedScoringJobCount, {
          phase: 'splitting', batch: context.topLevelBatch, attemptSize: batch.length,
          detail: 'attempt-failed',
        });
        const mid = Math.ceil(batch.length / 2);
        const left = await scoreBatch(batch.slice(0, mid), context);
        const right = await scoreBatch(batch.slice(mid), context);
        return [...left, ...right];
      }
      return [null]; // a single job that still failed is genuinely unscoreable
    };

    // Live per-batch scoring progress → the hub's 'scoring' state can show a
    // determinate "N / M scored" counter plus the in-flight batch/phase instead
    // of an apparently frozen 0/M while a streamed response is still working.
    // Real-time path only (the async Batch-API path returns above — nothing to
    // report live). Granularity is per top-level batch (~jobScoringBatchSize jobs),
    // since a batch resolves atomically. Best-effort: a destroyed sender (window
    // closed mid-run) is a silent no-op — progress is cosmetic, never blocks scoring.
    const emitScoringProgress = (scored, details = {}) => {
      if (scoringSuperseded) return;
      const payload = {
        nodeId: nodeId || null,
        scored,
        total: toScore.length,
        batch: details.batch ?? batches,
        batchTotal: scoringBatches.length,
        phase: details.phase || 'starting',
        attemptSize: details.attemptSize ?? null,
        rootBatchSize: details.rootBatchSize ?? null,
        detail: details.detail || null,
        heartbeat: !!details.heartbeat,
        recoveryMode: manualAiRecoveryMode || null,
        analysisRevisionId,
        snapshotCreatedAtMs: snapshotCreatedAtMs(snapshot),
        // Cosmetic events still need the same exact operation fence as the
        // score result. A newer run may reuse this hub id and career snapshot.
        operationAuthority: scoringAuthority,
      };
      jobsTelemetry.scoringHeartbeat = {
        ts: Date.now(),
        active: true,
        ...payload,
      };
      try {
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('scoring-progress', payload);
        }
      } catch { /* sender gone — ignore */ }
    };

    emitScoringProgress(0); // paint "0 / M" immediately so the counter isn't blank
    try {
      // Every top-level batch is independent. Keep no more than the bounded
      // worker count in flight, then refill the exact slot as soon as a sibling
      // settles. Unbounded dispatch would put every batch on screen at once;
      // fixed waves would leave workers idle behind one slow sibling. Source
      // order is retained for the result, history, and audit stages below.
      batches = scoringBatches.length;
      const completedBatches = await mapAutomaticHandoffs(scoringBatches, HANDOFF_CONCURRENCY, async (batch, batchIndex) => {
          if (signal?.aborted) throw signal.reason || new Error('Job scoring cancelled.');
          const topLevelBatch = batchIndex + 1;
          // Reuse the saved rows of jobs whose scoring input did not change and
          // pay for a handoff only for the rest. The fingerprint covers the slim
          // row the prompt is built from, src career snapshot and prefix.
          const { fingerprints, reused, pendingIndices } = partitionBatchForReuse(batch, {
            fingerprintOf: job => jobScoreReuseFingerprint({
              contract: JOB_SCORING_CONTRACT,
              prefix: cachedPrefix,
              careerSnapshotId,
              job: slimBatch([job])[0],
            }),
            store: reuseStore,
            // A saved row is only reused when it still passes the same
            // calibration the live card requires for THIS job's text.
            isReusable: (row, job) => {
              try {
                return prepareLiveScoringResults([{ ...row, index: 0 }], [postingJob(job)], {
                  candidateText: candidateFitText,
                  candidateRoles,
                }).scores[0] != null;
              } catch {
                return false;
              }
            },
          });
          const pendingJobs = pendingIndices.map(index => batch[index]);
          const scoredRows = pendingJobs.length > 0
            ? await scoreBatch(pendingJobs, { topLevelBatch, rootBatchSize: pendingJobs.length })
            : [];
          const results = mergeReusedAndScored(batch.length, reused, pendingIndices, scoredRows);
          if (reused.size > 0) {
            reusedScoreCount += reused.size;
            logger.info(`[Jobs][${nodeId}] Batch ${topLevelBatch}: reused ${reused.size} saved score(s) for unchanged listings, scoring ${pendingJobs.length}`);
          }
          const liveResults = prepareLiveScoringResults(results, batch.map(postingJob), { candidateText: candidateFitText, candidateRoles });
          // Keep the rows that just validated so a resumed run can reuse them.
          // A save failure is never a scoring failure.
          const freshRows = [];
          for (const [index, row] of results.entries()) {
            if (reused.has(index) || !row || typeof row !== 'object') continue;
            if (liveResults.scores[index] == null || !fingerprints[index]) continue;
            freshRows.push({ fingerprint: fingerprints[index], row });
          }
          if (freshRows.length > 0) {
            try {
              await reuseStore.record(freshRows);
            } catch (error) {
              logger.warn(`[Jobs][${nodeId}] Could not save reusable score rows for batch ${topLevelBatch}: ${error?.message || error}`);
            }
          }
          completedScoringJobCount += batch.length;
          emitScoringProgress(completedScoringJobCount, {
            phase: 'batch-complete', batch: topLevelBatch, attemptSize: batch.length,
          });
          return { batch, liveResults };
        }, { signal });
      for (const { batch, liveResults } of completedBatches) {
        const { scores: calibratedResults, allNull } = liveResults;
        if (allNull) failedBatches++; // batch produced zero usable scores even after splitting
        placeholderCount += liveResults.placeholderCount;
        ungroundedScoreCount += liveResults.ungroundedScoreCount;
        batch.forEach((job, idx) => {
          const score = calibratedResults[idx];
          // Shared with the Batch-API path so the matched/placeholder shape and the
          // two fallback strings stay in lockstep (see jobBatchReconcile.js).
          const scoredJob = buildScoredJob(job, score ? {
            ...score,
            scoringEvidenceReceipt: {
              ...score.scoringEvidenceReceipt,
              contract: JOB_SCORING_CONTRACT,
              careerSnapshotId,
              mode: 'complete-career-record',
            },
          } : null, { fallbackScore: UNSCORED_FALLBACK_SCORE, allNull });
          scoredJobs.push(scoredJob);
        });
      }


    if (!await scoringIsCurrent()) {
      scoringSuperseded = true;
      return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before scoring could finish.' };
    }

    // ── Targeted gap review ────────────────────────────────────────────────
    // The evidence-gap ceilings are deterministic policy over the model's own
    // gap inventory, so a mislabelled priority, one posting clause split into
    // two gap rows, or overlooked candidate evidence can pull a job the model
    // placed at or above the application bar below it. Re-scoring everything
    // twice would double every scoring handoff; this stage spends one small
    // handoff on exactly those capped-across-bar jobs and asks only about the
    // rows that caused the cap (jobGapReview.js). The host re-grounds every
    // quote and recomputes the score with the same rules, so a review can
    // never lift a score above the model's raw number. A failed review leaves
    // the calibrated scores exactly as they were and says so in telemetry.
    const gapReviewThreshold = RESEARCH_MIN_FIT_SCORE;
    const { telemetry: gapReviewTelemetry, attempted: gapReviewAttempted } = await runGapReviewPass(scoredJobs, {
      postingJob, candidateText: candidateFitText, signal, runGapReview, assertCurrent: assertScoringCurrent,
      onProviderCall: () => { providerCalls += 1; },
      onStart: count => emitScoringProgress(completedScoringJobCount, {
        phase: 'gap-review', batch: scoringBatches.length, attemptSize: count,
      }),
    });
    if (gapReviewAttempted) {
      if (!await scoringIsCurrent()) {
        scoringSuperseded = true;
        return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded during the gap review.' };
      }
    }

    // Hiring fit remains the primary sort. For equal fit scores, preserve the
    // user's soft Job Preferences as a separate deterministic tie-breaker;
    // preferenceScore never contributes to or mutates matchScore itself.
    scoredJobs.sort((a, b) => (
      b.matchScore - a.matchScore
      || (Number(b.preferenceAssessment?.preferenceScore) || 0) - (Number(a.preferenceAssessment?.preferenceScore) || 0)
      || (Number(a.preferenceAssessment?.conflictingSoftPreferences) || 0) - (Number(b.preferenceAssessment?.conflictingSoftPreferences) || 0)
    ));

    // Group by career direction
    const clusters = {};
    for (const job of scoredJobs) {
      const dir = job.careerDirection || 'Other';
      if (!clusters[dir]) clusters[dir] = [];
      clusters[dir].push(job);
    }

    logger.info(`[Jobs] Scored ${scoredJobs.length} jobs across ${Object.keys(clusters).length} career directions`);
    if (!await scoringIsCurrent()) {
      scoringSuperseded = true;
      return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before scoring telemetry could be recorded.' };
    }
    jobsTelemetry.scoring = {
      ts: Date.now(),
      // A receipt can only use this aggregate when it belongs to the staged
      // search completed later. Snapshot context is the renderer's durable
      // provenance carrier; direct re-scores intentionally leave this null.
      runId: snapshotContext?.runId || null,
      recoveryMode: manualAiRecoveryMode || null,
      analysisRevisionId,
      snapshotCreatedAtMs: snapshotCreatedAtMs(snapshot),
      input: gathered.length,            // jobs the renderer handed us (post gather/dedup/age/history)
      selectedForScoring: toScore.length, // after the across-source budget cap
      candidatePoolJobCount: Array.isArray(snapshot.jobs) ? snapshot.jobs.length : null,
      cappedForBudget,                    // gathered − selected: by-design overflow, NOT a failure
      scored: scoredJobs.length,
      placeholders: placeholderCount,
      ungroundedScores: ungroundedScoreCount,
      // Rows a resumed run reused from its own saved per-job scores instead of
      // re-scoring an otherwise identical listing (jobScoreReuse.js).
      reusedScoreCount,
      // How often the deterministic evidence-gap ceilings moved a score, and
      // how many jobs they moved from at-or-above the application bar to
      // below it. Count-only; the per-job detail lives in each card's audit.
      calibration: summarizeFitCalibration(scoredJobs, { threshold: RESEARCH_MIN_FIT_SCORE }),
      // The targeted gap review's own counts (candidates, handoffs, failures)
      // plus the per-job outcomes read back from each reviewed audit.
      gapReview: { ...gapReviewTelemetry, ...summarizeGapReviews(scoredJobs, { threshold: gapReviewThreshold }) },
      batches,
      failedBatches,
      providerCalls,
      partialRecoveryCalls,
      partialRecoveryRowAttempts,
      failureReason: lastFailureReason, // WHY a batch failed (e.g. oversized prompt); null when none failed

      // >0 means the abort signal cut the batch loop short, so these SELECTED jobs
      // were never sent to the scorer (distinct from cappedForBudget, which were
      // intentionally not selected, and placeholders, which were sent but unusable).
      unscored: toScore.length - scoredJobs.length,
      inputQuality,
      // Distinct free-form careerDirection labels the scorer emitted across all
      // batches. The scorer invents these per-batch (no shared vocabulary), so a
      // high count vs. the bucketer's final category count = fragmentation the
      // global bucketing pass had to consolidate. A health signal for the
      // AI-owned taxonomy: e.g. "16 directions → 10 categories" means weak
      // merging (common on the quota-forced flash-lite bucketer).
      directions: Object.keys(clusters).length,
      // Distinct model(s) that served the score batches — usually one, but the
      // fallback chain can shift mid-run if a model starts 429ing between batches.
      models: [...scoringModels],
      fallbacks: scoringFallbacks.slice(0, 12),
      fallbackOmitted: Math.max(0, scoringFallbacks.length - 12),
      audit: buildScoringAudit(scoringAuditRowsFromBatches(scoringBatches, scoredJobs)),
    };
    if (manualAiRecoveryMode === REANALYZE_SAVED_JOBS_RECOVERY_MODE && analysisRevisionId) {
      const unscored = toScore.length - scoredJobs.length;
      const clean = scoredJobs.length === toScore.length
        && placeholderCount === 0 && unscored === 0 && failedBatches === 0;
      // Separate from the source-search terminal receipt: saved-job reanalysis
      // never re-runs collection and must not overwrite that source-run fact.
      if (!await scoringIsCurrent()) {
        scoringSuperseded = true;
        return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before recovery telemetry could be recorded.' };
      }
      await recordAnalysisRecoveryLifecycle({
        operation: 'reanalysis-score-complete',
        result: clean ? 'completed' : 'partial',
        reason: 'reanalysis-score-complete',
        canvasFilePath: snapshot.canvasFilePath,
        ownerId: jobAnalysisSnapshotOwner(snapshot),
        runId: snapshot.runId,
        recoveryMode: manualAiRecoveryMode,
        analysisRevisionId,
        snapshotCreatedAtMs: snapshotCreatedAtMs(snapshot),
        scoringInputCount: toScore.length,
        scoredJobCount: scoredJobs.length,
        placeholderCount,
        unscoredJobCount: unscored,
        failedBatchCount: failedBatches,
        candidatePoolJobCount: Array.isArray(snapshot.jobs) ? snapshot.jobs.length : null,
        // Counts only: how the re-run Job Preferences split the candidate pool.
        preferenceMatchedCount: preferenceEvaluation?.counts?.accepted ?? null,
        preferenceFilteredCount: preferenceEvaluation?.counts?.filtered ?? null,
      });
    }

    // Compensation runs at board Combine, after global taxonomy bucketing.
    // That stage sees the final merged jobs and can share market cohorts across
    // source modules; scoring stays a pure fit-analysis operation.
    if (!await scoringIsCurrent()) {
      scoringSuperseded = true;
      return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded before the scoring reply.' };
    }
    return { scoredJobs, clusters, aiSkipped: false, collectionOnly: false, testMode: false,
      scoringComplete: placeholderCount === 0 && ungroundedScoreCount === 0 && scoredJobs.length === toScore.length,
    };
    } catch (error) {
      if (isJobOperationSupersededError(error)) {
        return { jobs: [], operationSuperseded: true, error: 'This Job Search operation was superseded while scoring.' };
      }
      throw error;
    } finally {
      // Cancellation throws out of scoreBatch before the normal loop tail. Always
      // close the live heartbeat so a later report cannot claim scoring is still
      // active after Reset has already unregistered the IPC task.
      if (!scoringSuperseded) jobsTelemetry.scoringHeartbeat = {
        ...(jobsTelemetry.scoringHeartbeat || {}),
        ts: Date.now(),
        active: false,
        phase: signal?.aborted ? 'aborted' : 'completed',
        interruptedPhase: signal?.aborted ? (jobsTelemetry.scoringHeartbeat?.phase || null) : null,
        cancellationReason: signal?.aborted
          ? String(signal.reason?.message || signal.reason || 'Operation cancelled').slice(0, 240)
          : null,
        // Parallel batches can complete before Promise.all reaches the ordered
        // assembly below. Cancellation must report that completed work without
        // treating it as a partial result to save or display.
        scored: signal?.aborted ? completedScoringJobCount : scoredJobs.length,
        total: toScore.length,
        batch: batches,
        batchTotal: scoringBatches.length,
      };
    }
  }, { captureListingLiveness: true });

  // Board-stage compensation research. Called after successful taxonomy
  // bucketing, so equivalent jobs across all merged search hubs share market
  // cohorts. Failures are represented per job as uncertain assessments rather
  // than discarding the board's scored jobs.
  handleSafe('research-job-compensation', async (event, { jobs, nodeId, requestId = null, remoteResidences, salaryCareerSnapshotId } = {}, signal) => {
    if (!Array.isArray(jobs)) throw new Error('Compensation research requires a jobs array.');
    const telemetry = getScopedJobsTelemetry(); // pin this attempt before reading career/model data
    const startedAt = Date.now();
    telemetry.compensation = { ts: startedAt, scoredInput: jobs.length };
    logger.info(`[Jobs][${nodeId}] Board compensation started: ${jobs.length} job(s)`);
    try {
      const careerInputs = await resolveBoardCompensationCareerInputs(jobs, { signal, salaryCareerSnapshotId });
      const enrichedJobs = await researchCompensationAssessments(jobs, {
        remoteResidences: remoteResidences || {}, event, nodeId, requestId, signal, careerInputs, salaryCareerSnapshotId,
      });
      logger.info(`[Jobs][${nodeId}] Board compensation completed: ${enrichedJobs.length} job(s) in ${Date.now() - startedAt}ms`);
      return { success: true, jobs: enrichedJobs };
    } catch (error) {
      telemetry.compensation = { ...telemetry.compensation, ts: Date.now(), error: true, errorCode: error?.code || null };
      logger.warn(`[Jobs][${nodeId}] Board compensation ${signal?.aborted ? 'cancelled' : 'failed'} after ${Date.now() - startedAt}ms`);
      throw error;
    } finally {
      // Renderer-injected per-origin residence context must never become card
      // or canvas data after it has served its one board-stage purpose.
      for (const job of jobs) { delete job?.compensationRemoteResidences; delete job?.compensationSearchCountry; }
    }
  });

  // Jobs a Board's own preferences pass that their Search never scored. Their
  // scores live on the Board, so the Search's result and scoring snapshot stay.
  handleSafe('score-board-preference-jobs', async (_event, { jobs, careerSnapshotId, nodeId } = {}, signal) => {
    if (!Array.isArray(jobs)) throw new Error('Board preference scoring requires a jobs array.');
    if (jobs.length === 0) return { success: true, scoredJobs: [] };
    const { scored, failed } = await scoreRowsOnCareerRecord({ jobs, careerSnapshotId, nodeId, signal, callScore: runScoreBatch, runGapReview,
      readPinned: resolvePinnedScoringInputForHandler, attemptKind: 'board-preferences' });
    const unscored = failed.map(job => buildScoredJob(job, null, { fallbackScore: UNSCORED_FALLBACK_SCORE, allNull: false }));
    // A new score is for this career version; drop any record of an earlier one.
    return { success: true, scoredJobs: [...scored, ...unscored].map((row) => {
      const next = { ...row, careerSnapshotId };
      delete next.scoredCareerSnapshotId;
      return next;
    }) };
  });

  // ── Board research for jobs at or above the fit threshold ────────────────
  // The Board's official-posting stage has already looked up the eligible rows.
  // This stage finishes what used to run before scoring, for those rows only:
  // listing recheck, official dedup, closed-listing settlement, one rescore when
  // official text materially differs, and deferred company research. Rows below
  // the threshold pass through untouched; a confirmed-closed one is reported for
  // removal. Indexes are into the request, so the renderer can keep protected cards.
  handleSafe('settle-board-research', async (event, { jobs, nodeId, manualAiRunId, officialLookups = 0 } = {}, signal) => {
    if (!Array.isArray(jobs)) throw new Error('Board research requires a jobs array.');
    const telemetry = getScopedJobsTelemetry();
    const rows = jobs.slice();
    const counts = { ...summarizeResearchEligibility(rows), officialLookups: Math.max(0, Number(officialLookups) || 0),
      livenessVisited: 0, livenessRechecked: 0, livenessStillPending: 0, officialDuplicatesDropped: 0, closedDropped: 0,
      belowFitClosedDropped: 0, rescoreAttempted: 0, rescoreChanged: 0, rescoreFellBelow: 0, rescoreFailed: 0,
      preferenceRows: 0, preferenceRequests: 0, preferenceFiltered: 0, preferenceFailed: 0 };
    telemetry.boardResearch = { ts: Date.now(), ...counts };
    const dropped = new Map();
    try {
    const eligibleIndexes = () => rows.flatMap((job, index) => (!dropped.has(index) && isResearchEligible(job) ? [index] : []));

    if (eligibleIndexes().some(index => normalizeListingLiveness(rows[index]?.listingLiveness)?.verdict === 'pending')) {
      const indexes = eligibleIndexes();
      const recheck = await recheckPendingListings(indexes.map(index => rows[index]), { signal,
        createProbe: dependencies.createListingLivenessProbe || createListingLivenessProbe,
        createSession: () => createListingLivenessSearchSession({
          callText: callListingLiveness, calibrationStore: listingLivenessCalibrationStore, signal, nodeId, manualAiRunId,
          abortError: nodeCancellationError,
        }) });
      indexes.forEach((index, position) => { rows[index] = recheck.rows[position]; });
      counts.livenessVisited = recheck.visited;
      counts.livenessRechecked = recheck.rechecked;
      counts.livenessStillPending = recheck.stillPending;
    }

    // A page on an ATS host is the employer's own listing authority, so its
    // AI-confirmed close needs no further check.
    for (const index of eligibleIndexes()) {
      const row = rows[index];
      const evidence = readListingEvidence(row);
      if (row?.listingLiveness?.verdict === 'closed' && row.listingLiveness.basis === 'ai' && evidence?.finalHostClass === 'ats'
        && !officialPostingOutranksClosedPage(row, evidence?.finalUrl)) {
        dropped.set(index, 'closed');
        counts.closedDropped += 1;
      }
    }

    // First copy wins the official dedup, so the best score goes first.
    const byScore = eligibleIndexes().sort((a, b) => rows[b].matchScore - rows[a].matchScore || a - b);
    const positionOfRow = new Map(byScore.map(index => [rows[index], index]));
    for (const { kept: winner, dropped: row } of officialPostingDedup(byScore.map(index => rows[index])).dropped) {
      dropped.set(positionOfRow.get(row), 'official-duplicate');
      counts.officialDuplicatesDropped += 1;
      // The kept row now stands for the dropped one too, so it takes the
      // earlier applied-listing check (or none). Mutated in place: later
      // stages find rows by identity through positionOfRow.
      foldAppliedCheckInto(winner, [winner, row]);
    }

    const settled = await settleBoardClosedRowsForHandler(eligibleIndexes().map(index => rows[index]), {
      requireSemantic: true, researchDeferred: true, scoreSafe: hasResolvedJobDescription,
    });
    for (const { row } of settled.dropped) {
      dropped.set(positionOfRow.get(row), 'closed');
      counts.closedDropped += 1;
    }
    rows.forEach((job, index) => {
      // A live employer page outranks the board's closed verdict at any score.
      if (classifyResearchEligibility(job) === RESEARCH_ELIGIBILITY.belowThreshold && listingStateRank(job) === 4
        && !['found', 'link-only'].includes(normalizeOfficialPosting(job?.officialPosting)?.outcome)) {
        dropped.set(index, 'below-fit-closed');
        counts.belowFitClosedDropped += 1;
      }
    });

    await rescoreMaterialOfficialText({ rows, indexes: eligibleIndexes(), counts, nodeId, signal,
      callScore: runScoreBatch, runGapReview, readPinned: resolvePinnedScoringInputForHandler });

    const pendingPreference = eligibleIndexes().filter(index => rows[index]?.preferenceAssessment?.companyResearchPending);
    if (pendingPreference.length) {
      counts.preferenceRows = pendingPreference.length;
      try {
        // Criteria are researched against the official employer, not a recruiter that posted the job.
        const researched = await researchDeferredJobPreferences({ jobs: await officialPostingConsumerJobs(pendingPreference.map(index => rows[index])),
          signal, callText: callLLMText, callRaw: callLLMRaw,
          companyResearchPipelineEligible: !(await durableRunHasAnyTask(manualAiRunId, ['job-preference-research-batch-assessment'], { batchTotal: 'present' })) });
        counts.preferenceRequests = researched.requests;
        pendingPreference.forEach((index, position) => {
          rows[index] = restoreOfficialPostingConsumerIdentity(researched.jobs[position]);
          if (rows[index].preferenceAssessment.status === 'filtered') {
            dropped.set(index, 'preference-filtered');
            counts.preferenceFiltered += 1;
          }
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        // Unverified stays unverified: the job remains visible and says so.
        counts.preferenceFailed = pendingPreference.length;
        logger.warn(`[Jobs][${nodeId}] Deferred company research failed: ${error?.code || error?.name || 'Error'}`);
      }
    }
    telemetry.boardResearch = { ts: Date.now(), ...counts };
    logger.info(`[Jobs][${nodeId}] Board research: ${counts.eligible}/${counts.total} at or above ${counts.minFitScore}, ${dropped.size} removed`);
    return { success: true, jobs: rows, dropped: [...dropped].map(([index, reason]) => ({ index, reason })), counts };
    } catch (error) {
      telemetry.boardResearch = { ts: Date.now(), ...counts, error: true, errorCode: error?.code || null };
      throw error;
    }
  }, { captureListingLiveness: true });

  // ── Confirm near-identical multi-location postings ───────────────────────
  // The renderer has already excluded preference-filtered rows before this
  // Board-stage call. The shared helper repeats that gate defensively and
  // queues only deterministic ≥75% wording candidates through the existing
  // automatic handoff pool. A false/unclear verdict leaves both cards intact.
  handleSafe('confirm-job-location-consolidations', async (_event, { jobs, nodeId } = {}, signal) => {
    if (!Array.isArray(jobs)) throw new Error('Job location consolidation requires a jobs array.');
    const postingJob = await officialPostingConsumerMap(jobs);
    const result = await confirmSimilarJobLocationPairs(jobs, {
      postingJob,
      signal,
      callText: callLLMText,
      onProgress: ({ completed, total, batch, batchTotal }) => {
        logger.info(`[Jobs][${nodeId}] Location consolidation confirmation ${completed}/${total} pair(s), batch ${batch}/${batchTotal}`);
      },
    });
    if (result.candidateCount > 0) {
      logger.info(`[Jobs][${nodeId}] Location consolidation confirmed ${result.confirmedPairIds.length}/${result.candidateCount} similar pair(s) across ${result.batchCount} handoff batch(es)`);
    }
    return result;
  });

  // ── Bucket scored jobs into the results taxonomy ──────────────────────────
  // Runs after score-jobs. The results hierarchy is THREE levels — fit score →
  // salary range → job role → cards. Fit-score bands are fixed to
  // the scorer's rubric; the model creates salary ranges and consolidates the
  // per-job careerDirection guesses into clean role names. The strict indexed
  // contract and the local backstop both require complete assignments before
  // renderer placement; a partial taxonomy never becomes a plausible board.
  handleSafe('bucket-jobs', async (event, { jobs, nodeId }, signal) => {
    const telemetry = getScopedJobsTelemetry();
    logger.info(`[Jobs][${nodeId}] Bucketing ${jobs.length} jobs into fit-score/salary/role taxonomy`);
    recordJobsBoardScope(nodeId, event.sender?.id ?? null);
    telemetry.bucketing = { ts: Date.now(), input: jobs.length, roleCount: 0,
      placed: 0, missing: jobs.length, duplicated: 0, taxonomyStage: 'planning' };
    // This handler returns a taxonomy only; its local shadows never replace rows.
    const provider = NON_API_AI_TRANSPORT;
    const bucketMeta = {}; // populated with the model that actually served a taxonomy stage
    let taxonomyProgress = { stage: 'planning', completedBatches: 0, batchCount: 0, chunkSize: 0, vocabularySize: 0, representativeCount: 0, plannedAssignments: 0, classifiedAssignments: 0 };
    let result;
    try {
      jobs = await officialPostingConsumerJobs(jobs);
      result = await runBoardTaxonomy(jobs, {
        signal,
        meta: bucketMeta,
        callText: callLLMText,
        onProgress: (progress) => {
          // Keep only a bounded current-stage receipt; complete taxonomy data
          // remains in the validated final result, never a partial board.
          taxonomyProgress = {
            stage: progress.stage,
            completedBatches: progress.completedBatches,
            batchCount: progress.batchCount,
            chunkSize: progress.chunkSize || 0,
            vocabularySize: progress.vocabularySize || 0,
            representativeCount: progress.representativeCount || 0,
            plannedAssignments: progress.plannedAssignments || 0,
            classifiedAssignments: progress.classifiedAssignments || 0,
          };
          telemetry.bucketing = { ...telemetry.bucketing, ts: Date.now(), taxonomyStage: taxonomyProgress.stage,
            taxonomyChunksCompleted: taxonomyProgress.completedBatches, taxonomyChunkCount: taxonomyProgress.batchCount,
            taxonomyChunkSize: taxonomyProgress.chunkSize, taxonomyVocabularySize: taxonomyProgress.vocabularySize,
            taxonomyRepresentativeCount: taxonomyProgress.representativeCount,
            taxonomyPlannedAssignments: taxonomyProgress.plannedAssignments,
            taxonomyClassifiedAssignments: taxonomyProgress.classifiedAssignments };
          // A plan is always the first manual handoff; classifier chunks are
          // discovered only after it returns.  Label the 0/0 planning receipt
          // explicitly so it cannot look like a zero-job classification run.
          const classifierChunks = `${progress.completedBatches}/${progress.batchCount ?? '?'} classifier chunk(s)`;
          const detail = progress.stage === 'planning'
            ? '; awaiting the global plan to determine whether classifier work is needed'
            : progress.stage === 'planned'
              ? `; all ${progress.processed}/${progress.total} job(s) assigned by the bounded plan — no classifier handoff needed`
              : '';
          logger.info(`[Jobs][${nodeId}] Taxonomy ${progress.stage}: ${classifierChunks}, ${progress.processed}/${progress.total} job(s)${detail}`);
        },
      });
    } catch (err) {
      // A provider failure aborts Combine. Record why it failed, but never
      // manufacture a deterministic taxonomy or let the caller create a board
      // from a failed generation attempt. An ABORT isn't a provider failure —
      // don't stamp a spurious failure; just propagate.
      if (!signal?.aborted) {
        telemetry.bucketing = {
          ts: Date.now(),
          input: jobs.length,
          roleCount: 0,
          placed: 0,
          missing: jobs.length,
          duplicated: 0,
          model: bucketMeta.model || null,
          models: bucketMeta.models || (bucketMeta.model ? [bucketMeta.model] : []),
          fallback: bucketMeta.fallback || null,
          fallbacks: bucketMeta.fallbacks || (bucketMeta.fallback ? [bucketMeta.fallback] : []),
          strategy: 'bounded-plan-chunks',
          taxonomyStage: taxonomyProgress.stage,
          taxonomyChunksCompleted: taxonomyProgress.completedBatches,
          taxonomyChunkCount: taxonomyProgress.batchCount,
          taxonomyChunkSize: taxonomyProgress.chunkSize,
          taxonomyVocabularySize: taxonomyProgress.vocabularySize,
          taxonomyRepresentativeCount: taxonomyProgress.representativeCount,
          taxonomyPlannedAssignments: taxonomyProgress.plannedAssignments,
          taxonomyClassifiedAssignments: taxonomyProgress.classifiedAssignments,
          blocked: false,
          provider,
          capability: JOB_BOARD_GENERATION_CAPABILITY,
          errorCode: err?.code || null,
          error: err?.message || String(err),
        };
      }
      throw err;
    }

    // The schema enforces positional coverage, but do not let the sanitizer
    // recover a malformed provider response into a board. A Combine is atomic:
    // every selected job needs exactly one usable model-owned role before any
    // salary/label normalization can proceed.
    const rawRoleShape = inspectJobBoardRoleByIndex(result?.roleByIndex, jobs.length);
    const normalizedRoleByIndex = normalizeJobBoardRoleByIndex(result?.roleByIndex, jobs.length);
    const roleTaxonomy = validateJobBoardRoleTaxonomy(normalizedRoleByIndex, jobs.length);
    const modelRoles = rolesFromRoleByIndex(normalizedRoleByIndex, jobs.length);
    const rawRoleCoverage = roleCoverage(modelRoles, jobs.length);
    const malformedRoleShape = rawRoleShape.missingCount > 0
      || rawRoleShape.blankCount > 0
      || rawRoleShape.nonStringCount > 0
      || rawRoleShape.extraCount > 0;
    const incompleteRoleTaxonomy = malformedRoleShape
      || !roleTaxonomy.valid
      || rawRoleCoverage.roleCount === 0
      || rawRoleCoverage.placed !== jobs.length
      || rawRoleCoverage.missing !== 0
      || rawRoleCoverage.duplicated !== 0
      || rawRoleCoverage.invalid !== 0
      || rawRoleCoverage.malformedNames !== 0;
    if (incompleteRoleTaxonomy) {
      let reason;
      if (malformedRoleShape) {
        reason = `roleByIndex ${rawRoleShape.type} supplied ${rawRoleShape.receivedCount}/${jobs.length} required entries (${rawRoleShape.blankCount} blank, ${rawRoleShape.nonStringCount} non-string, ${rawRoleShape.extraCount} extra)`;
      } else if (!roleTaxonomy.valid) {
        reason = roleTaxonomy.reason;
      } else {
        reason = `${rawRoleCoverage.placed}/${jobs.length} usable role assignments`;
      }
      const error = invalidJobBoardTaxonomyError(reason, provider);
      const affectedIndices = [...new Set([
        ...rawRoleShape.missingIndices,
        ...rawRoleShape.blankIndices,
        ...rawRoleShape.nonStringIndices,
        ...rawRoleCoverage.missingIndices,
      ])].slice(0, 5);
      telemetry.bucketing = {
        ts: Date.now(),
        input: jobs.length,
        roleCount: rawRoleCoverage.roleCount,
        placed: rawRoleCoverage.placed,
        missing: rawRoleCoverage.missing,
        duplicated: rawRoleCoverage.duplicated,
        missingIndices: rawRoleCoverage.missingIndices,
        modelRoleCoverage: rawRoleCoverage,
        roleShape: rawRoleShape,
        failureSamples: affectedIndices.map(index => ({
          index,
          title: jobs[index]?.title || '',
          source: jobs[index]?.source || '',
          suggestedDirection: jobs[index]?.careerDirection || '',
        })),
        model: bucketMeta.model || null,
        models: bucketMeta.models || (bucketMeta.model ? [bucketMeta.model] : []),
        fallback: bucketMeta.fallback || null,
        fallbacks: bucketMeta.fallbacks || (bucketMeta.fallback ? [bucketMeta.fallback] : []),
        strategy: 'bounded-plan-chunks',
        taxonomyStage: taxonomyProgress.stage,
        taxonomyChunksCompleted: taxonomyProgress.completedBatches,
        taxonomyChunkCount: taxonomyProgress.batchCount,
        taxonomyChunkSize: taxonomyProgress.chunkSize,
        taxonomyVocabularySize: taxonomyProgress.vocabularySize,
        taxonomyRepresentativeCount: taxonomyProgress.representativeCount,
        taxonomyPlannedAssignments: taxonomyProgress.plannedAssignments,
        taxonomyClassifiedAssignments: taxonomyProgress.classifiedAssignments,
        blocked: false,
        provider,
        capability: JOB_BOARD_GENERATION_CAPABILITY,
        errorCode: error.code,
        error: error.message,
      };
      logger.warn(`[Jobs][${nodeId}] Job Board generation rejected malformed role taxonomy: ${reason}`);
      throw error;
    }
    // Schema validation guarantees positional coverage, not useful labels or
    // salary semantics. Capture model quality before canonicalization/recovery
    // so salary-bound repairs remain visible in diagnostics.
    const modelRoleCoverage = rawRoleCoverage;
    // With a complete role partition verified above, sanitization is limited to
    // canonical labels and salary ranges; it cannot turn a provider failure
    // into renderer-created role assignments.
    const sanitized = sanitizeJobTaxonomy({ ...result, roles: modelRoles }, jobs.length, jobs.map(j => j.salary), jobs);
    result = sanitized;
    const repairedRoleCoverage = roleCoverage(result?.roles, jobs.length);
    if (sanitized.repairs.length > 0) {
      logger.warn(`[Jobs][${nodeId}] Taxonomy repairs: ${sanitized.repairs.join('; ')}`);
    }
    // `likelihoodBands` is the persisted legacy field name. Its labels and
    // semantics are hiring-fit bands, not likelihood forecasts.
    const bandCount = result.likelihoodBands.length;
    const rangeCount = result.salaryRanges.length;
    const roleCount = result.roles.length;
    logger.info(`[Jobs][${nodeId}] Taxonomy: ${bandCount} hiring-fit band(s), ${rangeCount} salary range(s), ${roleCount} role(s)`);

    // The raw model defect is what needs investigation; the repaired coverage
    // independently verifies that no card was lost while making it renderable.
    if (modelRoleCoverage.missing > 0 || modelRoleCoverage.duplicated > 0 || modelRoleCoverage.invalid > 0 || modelRoleCoverage.malformedNames > 0) {
      logger.warn(
        `[Jobs][${nodeId}] Model role partition defect: ${modelRoleCoverage.placed}/${jobs.length} valid named placement(s) ` +
        `(${modelRoleCoverage.structuralPlaced} structurally claimed); ${modelRoleCoverage.unassigned} omitted, ` +
        `${modelRoleCoverage.malformedNameIndices.length} under malformed name(s), ${modelRoleCoverage.duplicated} duplicated, ` +
        `${modelRoleCoverage.invalid} invalid index(es) ` +
        `→ repaired ${repairedRoleCoverage.placed}/${jobs.length} placed`
      );
    }
    if (repairedRoleCoverage.missing > 0 || repairedRoleCoverage.duplicated > 0 || repairedRoleCoverage.invalid > 0) {
      logger.warn(
        `[Jobs][${nodeId}] Taxonomy repair coverage gap: ${repairedRoleCoverage.placed}/${jobs.length} placed, ` +
        `${repairedRoleCoverage.missing} missing, ${repairedRoleCoverage.duplicated} duplicated, ${repairedRoleCoverage.invalid} invalid`
      );
    }

    // Per-level breakdown so a bug report can judge whether the AI taxonomy is
    // sensible without reconstructing the tree from raw node diagnostics. Band
    // counts are deterministic — placed by THE SAME normalizeBands/placeBand the
    // renderer uses (buildJobTree.js), so this funnel can never silently report
    // different band counts than the canvas shows.
    const bands = normalizeBands(result.likelihoodBands);
    const { real: realRanges, unspecified } = normalizeRanges(result.salaryRanges);
    const bandCounts = new Map();
    if (bands.length) for (const j of jobs) {
      const lbl = placeBand(j.matchScore, bands)?.label || 'Match';
      bandCounts.set(lbl, (bandCounts.get(lbl) || 0) + 1);
    }
    const bandSummary = bands.map(b => ({ label: b.label, count: bandCounts.get(b.label) || 0 }));
    const salaryRangeLabels = (result?.salaryRanges || []).map(r => r.label).filter(Boolean);
    // Deterministic placement counts for the SECOND tree level, mirroring
    // bandSummary above. Bands and roles both reported how many jobs landed in
    // each; salary ranges reported labels only, so the one level whose buckets
    // the model invents had no realized shape in the report — its counts could
    // only be reconstructed from the bounded taxonomy placement audit. Uses the
    // same placeRange the renderer uses, so it can never disagree with the canvas.
    const rangeCounts = new Map();
    for (const j of jobs) {
      const label = placeRange(parseSalaryToNumeric(j.salary), realRanges, unspecified)?.label || 'Unspecified';
      rangeCounts.set(label, (rangeCounts.get(label) || 0) + 1);
    }
    const salaryRangeSummary = salaryRangeLabels.map(label => ({ label, count: rangeCounts.get(label) || 0 }));
    const roleSummary = (result?.roles || []).map((role) => {
      const idxs = (role?.jobIndices || []).filter(i => Number.isInteger(i) && i >= 0 && i < jobs.length);
      return {
        name: role?.name || 'Other',
        count: idxs.length,
        sampleTitles: idxs.slice(0, 3).map(i => jobs[i]?.title).filter(Boolean),
      };
    }).sort((a, b) => b.count - a.count);
    const roleByIndex = new Map();
    for (const role of result.roles) for (const index of role.jobIndices) {
      if (!roleByIndex.has(index)) roleByIndex.set(index, role.name);
    }
    // Keep this bounded trace focused. Reserve space for anomalous salary rows
    // even when they occur late, then fill the remaining slots in original order.
    const taxonomyAuditLimit = 20;
    const anomalyIndices = jobs
      .map((job, index) => salaryRangeAnomaly(job.salary) ? index : -1)
      .filter(index => index >= 0)
      .slice(0, 8);
    const taxonomyAuditIndices = new Set(anomalyIndices);
    for (let index = 0; index < jobs.length && taxonomyAuditIndices.size < taxonomyAuditLimit; index += 1) {
      taxonomyAuditIndices.add(index);
    }
    const taxonomyAudit = [...taxonomyAuditIndices].sort((a, b) => a - b).map((index) => {
      const job = jobs[index];
      const annualSalary = parseSalaryToNumeric(job.salary);
      const salaryAnomaly = salaryRangeAnomaly(job.salary);
      const band = placeBand(job.matchScore, bands);
      const range = placeRange(annualSalary, realRanges, unspecified);
      return {
        index,
        title: String(job.title || '').slice(0, 120),
        source: String(job.source || '').slice(0, 40),
        rawSalary: String(job.salary || '').slice(0, 160),
        annualSalary,
        salaryAnomaly,
        salaryRangeMetadata: salaryRangeMetadata(job.salary),
        // Where in the description that salary text came from. A raw value can be
        // perfectly well-formed and still be the WRONG NUMBER — one run recorded
        // "$346,104.00 per year" for a support role because that was an equity
        // grant ceiling, and the audit had no way to show it: the raw text alone
        // looked like a clean parse. The surrounding prose is what makes that
        // falsifiable without reopening the local scrape snapshot.
        salaryContext: salaryContextFor(job),
        // `likelihood` remains only for report compatibility. New diagnostics
        // consume fitBand so this cannot be read as a hiring forecast.
        fitBand: band?.label || 'Hiring fit',
        likelihood: band?.label || 'Hiring fit',
        salaryRange: range?.label || 'Unspecified',
        role: roleByIndex.get(index) || 'Other',
      };
    });

    telemetry.bucketing = {
      ts: Date.now(),
      input: jobs.length,
      roleCount: repairedRoleCoverage.roleCount,
      placed: repairedRoleCoverage.placed,
      missing: repairedRoleCoverage.missing,
      duplicated: repairedRoleCoverage.duplicated,
      missingIndices: repairedRoleCoverage.missingIndices,
      // Semantic quality of the exact AI response, before deterministic
      // recovery. Kept separately so `missing: 0` never hides a model failure.
      modelRoleCoverage,
      repairedRoleCoverage,
      bandSummary,
      salaryRangeLabels,
      salaryRangeSummary,
      roleSummary,
      taxonomyAudit,
      taxonomyAuditOmitted: Math.max(0, jobs.length - taxonomyAudit.length),
      taxonomyRepairs: sanitized.repairs,
      model: bucketMeta.model || null,
      models: bucketMeta.models || (bucketMeta.model ? [bucketMeta.model] : []),
      fallback: bucketMeta.fallback || null,
      fallbacks: bucketMeta.fallbacks || (bucketMeta.fallback ? [bucketMeta.fallback] : []),
      strategy: 'bounded-plan-chunks',
      taxonomyStage: 'complete',
      // `sanitizeJobTaxonomy` intentionally returns only the renderer-facing
      // tree, so orchestration metadata must come from the last bounded-run
      // progress receipt. Reading it from `result` after sanitization made a
      // successful 6/6 run report "classification not started" with max ?.
      taxonomyChunksCompleted: taxonomyProgress.completedBatches,
      taxonomyChunkCount: taxonomyProgress.batchCount,
      taxonomyChunkSize: taxonomyProgress.chunkSize,
      taxonomyVocabularySize: taxonomyProgress.vocabularySize,
      taxonomyRepresentativeCount: taxonomyProgress.representativeCount,
      taxonomyPlannedAssignments: taxonomyProgress.plannedAssignments,
      taxonomyClassifiedAssignments: taxonomyProgress.classifiedAssignments,
      blocked: false,
      provider,
      capability: JOB_BOARD_GENERATION_CAPABILITY,
      errorCode: null,
      error: null,
    };
    return {
      // Kept for persisted boards and renderer compatibility; values are
      // hiring-fit bands (see fitBand in the diagnostics above).
      likelihoodBands: result?.likelihoodBands || [],
      salaryRanges: result?.salaryRanges || [],
      roles: result?.roles || [],
    };
  });
}
