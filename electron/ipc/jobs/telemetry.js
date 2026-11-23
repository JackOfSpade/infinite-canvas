import { jobsTelemetry, getScopedJobsTelemetry, jobsTelemetryRegistry, boardTelemetryCanvasScope, JOB_BOARD_TELEMETRY_CAP, forgetIndeedLoginConfirmation } from './state.js';
import { getCurrentIpcRequestContext } from '../ipcUtils.js';
import path from 'path';
import { ALL_SOURCE_IDS } from './sourceRules.js';
import { sanitizePageTitleScreenReceipt } from './pageTitleScreen.js';
import { normalizeCareerSnapshotIdentifier } from './analysisStore.js';
import { jobAnalysisOperationAuthorityReceipt } from '../jobAnalysisOperationAuthorityStore.js';
import { readRunState, providerGatheredAtForManifest } from '../jobRunStaging.js';
import { invalidatePlatformSessionStatus, writeStatusCache } from '../accounts.js';

export const MAX_SOURCE_RUN_HISTORY_PER_SOURCE = 3;

export function historyWriteTelemetry(input, result = {}) {
  return {
    ts: Date.now(),
    input: Array.isArray(input) ? input.length : Number(input) || 0,
    written: Number(result.written) || 0,
    staged: Number(result.staged) || 0,
    // Displayed rows the source artifacts could prove. Zero from a real input
    // means nothing can become seen, which `staged` alone cannot tell apart
    // from rows that were already staged.
    eligible: Number.isFinite(result.eligible) ? result.eligible : null,
    pruned: Number(result.pruned) || 0,
    skipped: result.skipped || null,
    // Why the input jobs that produced no row produced no row (per key kind and
    // per source), plus rows already in the CSV that couldn't be parsed back.
    // Without these a bare written-count can't distinguish ordinary dedup from a
    // key that collapses distinct listings — see appendJobsHistoryLocked.
    skips: result.skips || null,
    unreadable: Number(result.unreadable) || 0,
    error: result.error || null,
  };
}

/**
 * The prose surrounding a job's salary text inside its own description, for the
 * taxonomy audit. Returns '' when the salary came from a structured field rather
 * than the body (nothing to quote) — which is itself the useful signal, since a
 * structured value can't have been mined out of the wrong sentence.
 */
export function salaryContextFor(job) {
  const sal = String(job?.salary || '').trim();
  const body = String(job?.snippet || job?.description || '').replace(/\s+/g, ' ');
  if (!sal || !body) return '';
  // Anchor on the first NUMBER in the salary text — the surrounding text is
  // formatted differently ("$346,104.00 per year" vs "USD$346,104.00 per year"),
  // so matching the whole string verbatim usually misses.
  const num = sal.match(/\d[\d,]*(?:\.\d+)?/)?.[0];
  const at = num ? body.indexOf(num) : -1;
  if (at < 0) return '';
  return body.slice(Math.max(0, at - 90), Math.min(body.length, at + num.length + 90)).trim();
}

/**
 * Coverage of the role partition a taxonomy response declares. This is kept
 * separate from sanitization: the report must be able to say both that a model
 * omitted/duplicated work AND that the deterministic repair subsequently gave
 * every card a renderable home.
 */
export function roleCoverage(roles, jobCount) {
  const count = Math.max(0, Number(jobCount) || 0);
  const structurallyPlaced = new Map();
  const placed = new Map();
  let invalid = 0;
  let duplicated = 0;
  let malformedNames = 0;
  const malformedNameIndices = new Set();
  for (const role of Array.isArray(roles) ? roles : []) {
    const rawName = role?.name;
    // Match sanitizeJobTaxonomy's acceptance rule: whitespace and oversized
    // nonblank labels are canonicalizable assignments, while a truly blank
    // label has no meaningful role and must be recovered from careerDirection.
    const normalizedName = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const usableName = !!normalizedName;
    if (!usableName) malformedNames += 1;
    for (const index of Array.isArray(role?.jobIndices) ? role.jobIndices : []) {
      if (!Number.isInteger(index) || index < 0 || index >= count) {
        invalid += 1;
      } else {
        if (structurallyPlaced.has(index)) duplicated += 1;
        else structurallyPlaced.set(index, true);
        // An index under a blank/whitespace-only role name has no
        // usable model-owned role. Treat it as unassigned for semantic
        // coverage while retaining the exact affected indices for diagnostics.
        if (usableName) {
          // A valid name still establishes semantic coverage if an earlier
          // malformed row also claimed this index; the duplicate remains
          // visible in `duplicated`.
          if (!placed.has(index)) placed.set(index, true);
        } else {
          malformedNameIndices.add(index);
        }
      }
    }
  }
  const missingIndices = Array.from({ length: count }, (_, index) => index)
    .filter(index => !placed.has(index));
  const unassignedIndices = missingIndices.filter(index => !malformedNameIndices.has(index));
  return {
    roleCount: Array.isArray(roles) ? roles.length : 0,
    placed: placed.size,
    structuralPlaced: structurallyPlaced.size,
    missing: missingIndices.length,
    duplicated,
    invalid,
    malformedNames,
    malformedNameIndices: [...malformedNameIndices],
    // Missing because the model did not claim the index at all, rather than
    // because it placed it under an unusable role name.
    unassigned: unassignedIndices.length,
    unassignedIndices,
    missingIndices,
  };
}

/**
 * Collapse the model's positional labels into the persisted role partition.
 * Keep raw labels intact here: `sanitizeJobTaxonomy` needs to recognize a
 * blank/whitespace-only label as invalid and recover it from careerDirection rather
 * than accidentally treating it as a legitimate Other assignment.
 */
export function rolesFromRoleByIndex(roleByIndex, jobCount) {
  const count = Math.max(0, Math.floor(Number(jobCount) || 0));
  const grouped = new Map();
  const labels = Array.isArray(roleByIndex) ? roleByIndex : [];
  for (let index = 0; index < Math.min(count, labels.length); index += 1) {
    const name = typeof labels[index] === 'string' ? labels[index] : '';
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(index);
  }
  return [...grouped.entries()].map(([name, jobIndices]) => ({ name, jobIndices }));
}

export function recordHistoryWrite(stage, input, result) {
  if (!jobsTelemetry.history) jobsTelemetry.history = {};
  jobsTelemetry.history[stage] = historyWriteTelemetry(input, result);
}

export function getJobsTelemetry() {
  return getScopedJobsTelemetry();
}

// Bug reports know their reporting window and the Job Search hubs present in
// that canvas, but they are not node-addressed IPC calls. Do not let their
// `getJobsTelemetry()` fall through to whichever window most recently wrote
// telemetry when two windows happen to reuse a cloned hub ID. A report with
// several matching hub records is deliberately indeterminate rather than
// selecting one by recency and presenting another hub's live state as fact.
export function getJobsTelemetryForReport(currentNodeIds, reportWindowId = null) {
  const context = getCurrentIpcRequestContext();
  const sender = context?.sender;
  const ids = currentNodeIds instanceof Set ? currentNodeIds : new Set(currentNodeIds || []);
  // Contextless legacy callers may use ambient telemetry only when it is
  // unowned or belongs to a hub in this report. Real report IPC always has a
  // sender and uses the guarded sender-local branch below.
  if (!sender) return !jobsTelemetryRegistry.latest?.nodeId || ids.has(jobsTelemetryRegistry.latest.nodeId)
    ? jobsTelemetryRegistry.latest
    : null;
  if (reportWindowId != null && sender.id !== reportWindowId) return null;
  const byNode = jobsTelemetryRegistry.bySender.get(sender);
  if (!byNode) {
    // Handler-style tests can provide a synthetic sender while constructing
    // ambient telemetry directly. A real Electron WebContents has getURL();
    // if it has not produced local telemetry, fail closed rather than borrow
    // another window's ambient run.
    if (typeof sender?.getURL !== 'function') {
      return !jobsTelemetryRegistry.latest?.nodeId || ids.has(jobsTelemetryRegistry.latest.nodeId)
        ? jobsTelemetryRegistry.latest
        : null;
    }
    return null;
  }
  const matches = [...byNode.entries()]
    .filter(([nodeId, telemetry]) => ids.has(nodeId) && telemetry?.nodeId === nodeId)
    .map(([, telemetry]) => telemetry);
  return matches.length === 1 ? matches[0] : null;
}

export function __getJobsTelemetryForReportForTests(currentNodeIds, reportWindowId = null) {
  return getJobsTelemetryForReport(currentNodeIds, reportWindowId);
}

export const BOARD_BUCKET_COUNTS = ['ts', 'input', 'placed', 'missing', 'duplicated', 'roleCount',
  'taxonomyChunksCompleted', 'taxonomyChunkCount', 'taxonomyChunkSize', 'taxonomyVocabularySize',
  'taxonomyRepresentativeCount', 'taxonomyPlannedAssignments', 'taxonomyClassifiedAssignments', 'taxonomyAuditOmitted'];

export const BOARD_COMPENSATION_COUNTS = ['ts', 'scoredInput', 'eligible', 'preResearchCandidates', 'skippedBelowFit',
  'skippedNoExperience', 'skippedNoExperienceBand', 'missingOffer', 'recommendedNoOffer', 'skippedNoCurrency',
  'skippedNoLocation', 'roleBandLookups', 'roleBandResearches', 'roleBandCacheHits', 'roleBandFailures',
  'roleBandFailureJobs', 'roleBandUnavailable', 'roleBandUnavailableJobs', 'roleBandInterruptedJobs',
  'roleBandFallbackJobs', 'marketCandidates', 'cohorts', 'researched', 'failedCohorts', 'marketCohortFailures',
  'assessed', 'minFitScore', 'cacheHits'];

export const BOARD_RESEARCH_COUNTS = ['ts', 'minFitScore', 'total', 'eligible', 'skippedBelowFit', 'skippedUnscored', 'officialLookups',
  'livenessVisited', 'livenessRechecked', 'livenessStillPending', 'officialDuplicatesDropped', 'closedDropped', 'belowFitClosedDropped',
  'rescoreAttempted', 'rescoreChanged', 'rescoreFellBelow', 'rescoreFailed',
  'preferenceRows', 'preferenceRequests', 'preferenceFiltered', 'preferenceFailed'];

export const BOARD_LOCATION_COUNTS = ['postings', 'jobs', 'handoffs', 'cacheHit', 'overflowPostings', 'noIdentityJobs',
  'resolved', 'foundUnresolved', 'rejected', 'notFound', 'failed', 'interrupted'];

export const BOARD_TAXONOMY_STAGES = new Set(['planning', 'planned', 'classifying', 'complete']);

export const BOARD_ERROR_CODES = new Set(['JOB_BOARD_TAXONOMY_INVALID', 'STRUCTURED_OUTPUT_SCHEMA_INVALID',
  'NON_API_AI_CAPABILITY_UNAVAILABLE', 'ABORT_ERR', 'APP_QUIT_PAUSED']);

export function boardTelemetryCounts(value, keys) {
  const out = {};
  for (const key of keys) {
    if (typeof value?.[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0
      && (key !== 'ts' || Number.isFinite(new Date(value[key]).getTime()))) out[key] = value[key];
  }
  return out;
}

export function boardTelemetryStage(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...boardTelemetryCounts(value, keys), error: Boolean(value.error),
    errorCode: value.errorCode ? (BOARD_ERROR_CODES.has(value.errorCode) ? value.errorCode : 'OTHER') : null };
}

/**
 * Latest Board-stage attempts, independently attributable to this reporting
 * window's typed Board IDs. This is not a source funnel or run-ID correlation.
 * Export counts and fixed enums only: model text, cohort/listing identities,
 * salary prose, raw errors and source snapshots never leave this boundary.
 * An explicit canvas selects its captured canonical spelling; null selects
 * unsaved ownership. Neither the private scope nor a path is returned.
 */
export function getJobsBoardTelemetryForReport(boardIds, reportWindowId = null, canvasFilePath = undefined) {
  const sender = getCurrentIpcRequestContext()?.sender;
  if (!sender || !Number.isSafeInteger(sender.id) || sender.id < 0
    || (reportWindowId != null && sender.id !== reportWindowId)) return [];
  const ids = boardIds instanceof Set ? boardIds : new Set(Array.isArray(boardIds) ? boardIds : []);
  const byBoard = jobsTelemetryRegistry.boardBySender.get(sender);
  if (!byBoard) return [];
  if (canvasFilePath !== undefined && canvasFilePath !== null
    && (typeof canvasFilePath !== 'string' || !canvasFilePath.trim() || !path.isAbsolute(canvasFilePath))) return [];
  const canvasScope = boardTelemetryCanvasScope(canvasFilePath);
  const matches = [...byBoard.entries()].filter(([ownerKey, telemetry]) => ids.has(telemetry.boardNodeId)
    && ownerKey === JSON.stringify([jobsTelemetryRegistry.boardCanvasScope.get(telemetry), telemetry.boardNodeId])
    && telemetry.nodeId == null && telemetry.windowId === sender.id
    && (canvasFilePath === undefined || jobsTelemetryRegistry.boardCanvasScope.get(telemetry) === canvasScope))
    .map(([, telemetry]) => telemetry);
  // Older consumers supplied only window+Board IDs. Keep their
  // latest-owner view while real canvas-aware reports select exact ownership.
  return [...new Map(matches.map(telemetry => [telemetry.boardNodeId, telemetry])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, JOB_BOARD_TELEMETRY_CAP)
    .map(([boardNodeId, telemetry]) => {
      const bucketing = boardTelemetryStage(telemetry.bucketing, BOARD_BUCKET_COUNTS);
      if (bucketing) {
        bucketing.taxonomyStage = BOARD_TAXONOMY_STAGES.has(telemetry.bucketing.taxonomyStage) ? telemetry.bucketing.taxonomyStage : null;
        bucketing.blocked = telemetry.bucketing.blocked === true;
      }
      const compensation = boardTelemetryStage(telemetry.compensation, BOARD_COMPENSATION_COUNTS);
      if (compensation && telemetry.compensation.locationLookup) {
        compensation.locationLookup = boardTelemetryStage(telemetry.compensation.locationLookup, BOARD_LOCATION_COUNTS);
      }
      const displayed = telemetry.history?.boardDisplay;
      const boardDisplay = displayed && typeof displayed === 'object' && !Array.isArray(displayed)
        ? { ...boardTelemetryCounts(displayed, ['ts', 'input', 'staged', 'eligible', 'written', 'pruned', 'unreadable']),
          skipped: displayed.skipped === 'no-canvas-path' ? 'no-canvas-path' : null,
          skips: boardTelemetryCounts(displayed.skips, ['noKey', 'url', 'titleCompany', 'inBatch']), error: Boolean(displayed.error) }
        : null;
      return { boardNodeId, windowId: telemetry.windowId, bucketing, compensation,
        research: boardTelemetryStage(telemetry.boardResearch, BOARD_RESEARCH_COUNTS),
        history: boardDisplay ? { boardDisplay } : null };
    });
}

// This deliberately has DIFFERENT semantics from getJobsTelemetryForReport:
// the full funnel is unsafe to merge across hubs, while these tiny source-run
// receipts are independently attributable. FULL/JOBS/STALL must show every
// current-canvas hub's bounded schedule/warning history even when no single
// hub can truthfully own the combined funnel. Do not use it for any other
// telemetry section.
export function getJobsSourceRunHistoryForReport(currentNodeIds, reportWindowId = null) {
  const recordsFor = (nodeId, telemetry) => {
    if (!telemetry?.sourceRunHistory) return null;
    const history = Object.entries(telemetry.sourceRunHistory)
      // Receipts are written only for known source IDs. Keep that invariant at
      // the report boundary too, so malformed in-memory state cannot introduce
      // an unbounded/new source key into a diagnostics export.
      .filter(([sourceId, records]) => ALL_SOURCE_IDS.includes(sourceId) && Array.isArray(records) && records.length > 0)
      .map(([sourceId, records]) => ({ sourceId, records: records.slice(-MAX_SOURCE_RUN_HISTORY_PER_SOURCE) }));
    return history.length > 0 ? { nodeId, history } : null;
  };
  return reportAttributableHubTelemetry(currentNodeIds, reportWindowId)
    .map(([nodeId, telemetry]) => recordsFor(nodeId, telemetry))
    .filter(Boolean);
}

/**
 * The hub-attribution gate shared by getJobsSourceRunHistoryForReport and the
 * accessors below, returned as [nodeId, telemetry] pairs so they cannot drift
 * apart. Its branches are:
 * the contextless ambient fallback, the reportWindowId check, the synthetic
 * handler seam (a real Electron WebContents has getURL(), so a real window
 * that produced no sender-local telemetry fails closed rather than borrowing
 * another window's), and the `ids.has(nodeId) && telemetry?.nodeId === nodeId`
 * predicate. Note the one consequence that is inherited on purpose: a
 * telemetry record with NO nodeId is attributable to no hub here, even though
 * the contextless branch of getJobsTelemetryForReport still returns it.
 *
 * careerCompilation is the single narrow exception opt-in, used only by
 * getJobsCareerCompilationForReport: a compile stamps its own owner on
 * careerSnapshotCache and never calls recordJobsSourceScope, so a process that
 * only parsed career files has telemetry.nodeId === null. The helper below
 * attributes exactly those records by the compile's own stamp. Every other
 * caller keeps the strict predicate above.
 */
export function reportAttributableHubTelemetry(currentNodeIds, reportWindowId = null, { careerCompilation = false } = {}) {
  const context = getCurrentIpcRequestContext();
  const sender = context?.sender;
  const ids = currentNodeIds instanceof Set ? currentNodeIds : new Set(currentNodeIds || []);
  const attributable = (nodeId, telemetry) => careerCompilation
    ? careerCompilationOwnedBy(nodeId, telemetry)
    : telemetry?.nodeId === nodeId;
  const ambient = () => {
    // Career compiles are the one record that carries its own owner when the
    // ambient telemetry was never stamped by a search or rescore.
    const stamped = jobsTelemetryRegistry.latest?.careerSnapshotCache?.nodeId;
    const nodeId = careerCompilation && typeof stamped === 'string' && stamped
      ? stamped
      : jobsTelemetryRegistry.latest?.nodeId;
    return nodeId && ids.has(nodeId) && attributable(nodeId, jobsTelemetryRegistry.latest)
      ? [[nodeId, jobsTelemetryRegistry.latest]]
      : [];
  };
  if (!sender) return ambient();
  if (reportWindowId != null && sender.id !== reportWindowId) return [];
  const byNode = jobsTelemetryRegistry.bySender.get(sender);
  if (!byNode) {
    if (typeof sender?.getURL === 'function') return [];
    return ambient();
  }
  return [...byNode.entries()]
    .filter(([nodeId, telemetry]) => ids.has(nodeId) && attributable(nodeId, telemetry))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

/**
 * Career compiles write their owner id onto their own record, not onto the
 * enclosing telemetry: parse-career-data sets careerSnapshotCache.nodeId and
 * never calls recordJobsSourceScope, so a process that only dropped career
 * files has telemetry.nodeId === null. Requiring telemetry.nodeId therefore
 * dropped every such record from the report. A career record is attributable
 * to its map key when the compile's own stamp names that key; a stamp naming
 * another hub still excludes it, and a compile that left no stamp falls back
 * to the enclosing nodeId. Search/funnel attribution must not use this rule.
 */
export function careerCompilationOwnedBy(nodeId, telemetry) {
  const owner = telemetry?.careerSnapshotCache?.nodeId;
  return typeof owner === 'string' && owner ? owner === nodeId : telemetry?.nodeId === nodeId;
}

export const CAREER_CONVERGENCE_CATEGORIES = Object.freeze(['coverage', 'grounding', 'attribution', 'metrics', 'skills', 'conflict']);

export const CAREER_CONVERGENCE_COUNTERS = Object.freeze(['editsApplied', 'decisionsTotal', 'challengesAccepted', 'adjudications', 'findingsRejected', 'editRepairs', 'repairsDeclined', 'deterministicErrors']);

export const CAREER_CONVERGENCE_ROUND_CAP = 64;

export const isCareerCount = value => Number.isSafeInteger(value) && value >= 0;

export function sanitizeCareerFindingPair(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isCareerCount(value.blocker) || !isCareerCount(value.warning)) return null;
  return { blocker: value.blocker, warning: value.warning };
}

/**
 * Pure: returns a fresh object holding only the per-round convergence contract
 * keys, or null when the round or findings are invalid. Invalid counters and
 * unknown keys/categories are dropped, never coerced.
 */
export function sanitizeCareerConvergenceRound(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isSafeInteger(value.round) || value.round < 1) return null;
  const findings = sanitizeCareerFindingPair(value.findings);
  if (!findings) return null;
  const out = { round: value.round, findings };
  const byCategory = {};
  const rawCategories = value.byCategory && typeof value.byCategory === 'object' && !Array.isArray(value.byCategory) ? value.byCategory : null;
  if (rawCategories) {
    for (const category of CAREER_CONVERGENCE_CATEGORIES) {
      if (!Object.prototype.hasOwnProperty.call(rawCategories, category)) continue;
      const pair = sanitizeCareerFindingPair(rawCategories[category]);
      if (pair) byCategory[category] = pair;
    }
  }
  out.byCategory = byCategory;
  for (const key of CAREER_CONVERGENCE_COUNTERS) {
    if (isCareerCount(value[key])) out[key] = value[key];
  }
  return out;
}

/**
 * Appends one sanitized convergence round to a telemetry record, replacing an
 * existing entry for the same round, keeping the newest CAREER_CONVERGENCE_ROUND_CAP
 * and counting evictions. Returns true when an entry was retained.
 */
export function appendCareerConvergenceRound(telemetry, value) {
  if (!telemetry || typeof telemetry !== 'object') return false;
  const entry = sanitizeCareerConvergenceRound(value);
  if (!entry) return false;
  if (!Array.isArray(telemetry.convergenceRounds)) telemetry.convergenceRounds = [];
  const rounds = telemetry.convergenceRounds;
  const existing = rounds.findIndex(item => item?.round === entry.round);
  if (existing >= 0) rounds.splice(existing, 1);
  rounds.push(entry);
  if (rounds.length > CAREER_CONVERGENCE_ROUND_CAP) {
    const evicted = rounds.length - CAREER_CONVERGENCE_ROUND_CAP;
    rounds.splice(0, evicted);
    telemetry.convergenceRoundsEvicted = (isCareerCount(telemetry.convergenceRoundsEvicted) ? telemetry.convergenceRoundsEvicted : 0) + evicted;
  }
  return true;
}

// Compilation happens before the search funnel exists. Keep each hub's
// bounded cache/stage evidence independently reportable on multi-hub canvases.
export function getJobsCareerCompilationForReport(currentNodeIds, reportWindowId = null) {
  return reportAttributableHubTelemetry(currentNodeIds, reportWindowId, { careerCompilation: true })
    .filter(([, telemetry]) => telemetry?.careerSnapshotCache)
    .map(([nodeId, telemetry]) => ({ nodeId, cache: telemetry.careerSnapshotCache }));
}

/**
 * How many current-canvas hubs hold attributable telemetry in this window.
 *
 * getJobsTelemetryForReport fails closed at two or more matches, which is
 * correct — no single hub owns the combined funnel, and summing three hubs'
 * search/scoring/taxonomy counts would present one hub's numbers as another's.
 * But every reader of that null then printed "no search recorded this session"
 * / "no scoring recorded this session" / "not retained in this process" for a
 * process that had demonstrably just run three searches. That is an assertion
 * of absence the report never observed. This count is the observation it can
 * state instead: N hubs hold telemetry, so no single hub owns this section.
 */
export function getJobsTelemetryHubCountForReport(currentNodeIds, reportWindowId = null) {
  return reportAttributableHubTelemetry(currentNodeIds, reportWindowId).length;
}

/**
 * The per-hub records that ARE independently attributable even when the
 * combined funnel is not.
 *
 * `indeedSession` and `resumeAttempts` are written through the nodeId-scoped
 * telemetry proxy (getScopedJobsTelemetry keys on the request context's
 * nodeId), so each hub's copy describes only that hub's own Continue / Log in
 * / Solve clicks and the session its own scrape observed. Nothing is summed or
 * merged here, which is exactly what makes them safe to show per hub while the
 * funnel stays single-owner: a hub's row is either shown under its own nodeId
 * or not shown at all. Dropping the Resume attempts block on a multi-hub
 * canvas removed the single piece of evidence that explains "I clicked
 * Continue and nothing happened".
 */
export function getJobsResumeAttributionForReport(currentNodeIds, reportWindowId = null) {
  return reportAttributableHubTelemetry(currentNodeIds, reportWindowId)
    .map(([nodeId, telemetry]) => {
      const resumeAttempts = Object.entries(telemetry?.resumeAttempts || {})
        // Attempts are only ever recorded for a known provider id. Re-check
        // that at the report boundary too, so malformed in-memory state cannot
        // introduce an unbounded or unknown source key into a diagnostics
        // export, and re-apply the producer's own newest-12 cap: an in-memory
        // list mutated by anything other than recordResumeAttemptTelemetry
        // must not be able to grow the exported payload.
        .filter(([sourceId, attempts]) => ALL_SOURCE_IDS.includes(sourceId)
          && Array.isArray(attempts) && attempts.length > 0)
        .map(([sourceId, attempts]) => ({
          sourceId,
          attempts: attempts.slice(-MAX_RESUME_ATTEMPTS_PER_SOURCE),
        }))
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
      const indeedSession = telemetry?.indeedSession || null;
      // A hub that has neither observed a session nor been resumed has nothing
      // to report. Omit it rather than emitting an empty row that reads like a
      // hub which was asked and answered "nothing".
      if (!indeedSession && resumeAttempts.length === 0) return null;
      return { nodeId, indeedSession, resumeAttempts };
    })
    .filter(Boolean);
}

/**
 * Build the only job-search data allowed into a durable post-run receipt.
 * Hub-scoped telemetry is still run-filtered, so a late same-hub completion
 * never borrows a replacement run's funnel.
 */
export function buildJobRunCompletionReceipt(runId, completedAt = Date.now(), terminal = null) {
  const search = jobsTelemetry.search?.runId === runId ? jobsTelemetry.search : null;
  const pipeline = jobsTelemetry.pipeline?.runId === runId ? jobsTelemetry.pipeline : null;
  const scoring = jobsTelemetry.scoring?.runId === runId ? jobsTelemetry.scoring : null;
  // Resolve rows are process-global too.  Keep only their signed, cumulative
  // queue delta, and only when the row carries this exact run token.  This
  // reconciles an initial funnel with a post-search recovery after restart
  // without putting any listing/source-card content in the durable receipt.
  let recoveryMergeNet = 0;
  let hasRunScopedRecovery = false;
  for (const resolve of Object.values(jobsTelemetry.resolves || {})) {
    if (resolve?.runId !== runId || resolve?.hasMergeTelemetry !== true) continue;
    const net = Number(resolve.cumulativeMergeNet);
    if (!Number.isFinite(net)) continue;
    recoveryMergeNet += Math.trunc(net);
    hasRunScopedRecovery = true;
  }
  const sources = {};
  if (search?.bySource && typeof search.bySource === 'object') {
    for (const [sourceId, source] of Object.entries(search.bySource)) {
      sources[sourceId] = {
        count: source?.count,
        // Distinct candidate identities traversed, retained for compatibility.
        // It can exceed count when a detail page conclusively retires a closed
        // posting; `unavailableDetailDropped` carries that explicit delta.
        providerGathered: source?.providerGathered ?? source?.gathered,
        unavailableDetailDropped: source?.unavailableDetailDropped,
        boardClosedDetailKept: source?.boardClosedDetailKept,
        locationScopeUnenforced: source?.locationScopeUnenforced === true,
        // Corpus-coverage evidence. `providerGathered` alone cannot say whether
        // the walk saw the whole result set, so a receipt read after restart
        // could not tell a complete gather from a truncated one.
        providerTotal: source?.providerTotal ?? source?.claimedTotal,
        truncated: source?.truncated === true,
        pagesWalked: source?.pagesWalked,
        // Fixed contract for the bug report: dated cards the collection window
        // dropped, and which field checks failed.
        windowDropped: source?.windowDropped,
        alreadyReadSkipped: source?.alreadyReadSkipped,
        ...(sanitizePageTitleScreenReceipt(source?.pageTitleScreen) ? {
          pageTitleScreen: sanitizePageTitleScreenReceipt(source.pageTitleScreen),
        } : {}),
        healthFailures: Array.isArray(source?.healthFailures)
          ? source.healthFailures.slice(0, 8).map(({ field, rows, missing }) => ({ field, rows, missing }))
          : undefined,
        relevanceDropped: source?.relevanceDropped,
        sponsoredDropped: source?.sponsoredDropped,
        cap: source?.cap,
        caps: source?.caps,
        stopReason: source?.stopReason,
        ...(source?.googleApplyCapture ? { googleApplyCapture: source.googleApplyCapture } : {}),
        revealOutcomes: Array.isArray(source?.revealOutcomes)
          ? source.revealOutcomes.slice(0, 20)
          : [],
        warning: source?.warning
          ? { code: source.warning.code, severity: source.warning.severity }
          : null,
      };
    }
  }
  return {
    runId,
    ...(normalizeCareerSnapshotIdentifier(terminal?.careerSnapshotId) ? { careerSnapshotId: normalizeCareerSnapshotIdentifier(terminal.careerSnapshotId) } : {}),
    ...(jobAnalysisOperationAuthorityReceipt(terminal?.operationAuthority)
      ? { operationAuthority: jobAnalysisOperationAuthorityReceipt(terminal.operationAuthority) }
      : {}),
    // Hub identity is usable only with a matching search run.
    nodeId: search ? jobsTelemetry.nodeId : null,
    startedAt: pipeline?.startedAt ?? (search ? search.ts : null),
    completedAt,
    terminal: {
      status: ['completed', 'failed', 'aborted'].includes(terminal?.status)
        ? terminal.status
        : 'completed',
      outcome: ['zero', 'populated', 'collection-only', 'preference-filtered', 'incomplete', 'unknown'].includes(terminal?.outcome)
        ? terminal.outcome
        : search ? (Number(search.kept) > 0 ? 'populated' : 'zero') : 'unknown',
      ...(terminal?.scoreReadyCount != null && Number.isFinite(Number(terminal.scoreReadyCount))
        ? { scoreReadyCount: Math.max(0, Math.floor(Number(terminal.scoreReadyCount))) }
        : {}),
    },
    ...(search ? {
      funnel: {
        raw: search.raw,
        relevanceDropped: search.relevanceDropped,
        countryScopeDropped: search.countryScopeDropped,
        ...(search.windowEligible != null ? { windowEligible: search.windowEligible } : {}),
        ...(search.platformDuplicateDropped != null ? { platformDuplicateDropped: search.platformDuplicateDropped } : {}),
        ...(search.platformCapDropped != null ? { platformCapDropped: search.platformCapDropped } : {}),
        ...(search.platformUnique != null ? { platformUnique: search.platformUnique } : {}),
        ...(search.platformCapped != null ? { platformCapped: search.platformCapped } : {}),
        deduped: search.deduped,
        ageDropped: search.ageDropped,
        roleDropped: search.roleDropped,
        historyDropped: search.historyDropped,
        descriptionEvidenceDropped: search.descriptionEvidenceDropped?.total,
        ...(search.descriptionEvidenceDropped?.bySource ? { descriptionEvidenceBySource: search.descriptionEvidenceDropped.bySource } : {}),
        finalDedupDropped: search.finalDedupDropped,
        ...(search.officialDedupDropped != null ? { officialDedupDropped: search.officialDedupDropped } : {}),
        ...(search.officialLookupsIncomplete != null ? { officialLookupsIncomplete: search.officialLookupsIncomplete } : {}),
        ...(search.listingRecheck ? { listingRecheck: search.listingRecheck } : {}),
        ...(search.boardClosedSetAside > 0 ? { boardClosedSetAside: search.boardClosedSetAside } : {}),
        ...(search.boardClosedDropped > 0 ? { boardClosedDropped: search.boardClosedDropped } : {}),
        ...(search.languageDropped != null ? { languageDropped: search.languageDropped } : {}),
        kept: search.kept,
      },
    } : {}),
    // Scoring telemetry is also process-global. A direct re-score or a second
    // canvas can finish between this run's gather and completion, so retain it
    // only when the scoring snapshot carries this exact durable run token.
    ...(scoring ? {
      scoring: {
        input: scoring.input,
        selected: scoring.selectedForScoring,
        scored: scoring.scored,
        placeholders: scoring.placeholders,
        unscored: scoring.unscored,
        failedBatches: scoring.failedBatches,
        cappedForBudget: scoring.cappedForBudget,
        providerCalls: scoring.providerCalls,
        ...(scoring.calibration ? { calibration: scoring.calibration } : {}),
        ...(scoring.gapReview ? { gapReview: scoring.gapReview } : {}),
      },
    } : {}),
    ...(hasRunScopedRecovery ? { recovery: { mergeNet: recoveryMergeNet } } : {}),
    ...(search?.officialPosting?.listingLiveness ? { listingLiveness: search.officialPosting.listingLiveness } : {}),
    sources,
    stagingStarted: pipeline?.stagingStarted === true,
  };
}

export function sourceRunHistorySummary(sourceId, runId, now = Date.now()) {
  const sid = String(sourceId || '').trim();
  // The process only has a fixed provider set. Refusing unknown identifiers
  // gives this cross-run diagnostic ring a hard global bound (9 × 3 records
  // per hub) and keeps arbitrary progress payload keys out of reports.
  if (!ALL_SOURCE_IDS.includes(sid)) return null;
  const histories = jobsTelemetry.sourceRunHistory || (jobsTelemetry.sourceRunHistory = {});
  const history = Array.isArray(histories[sid]) ? histories[sid] : (histories[sid] = []);
  if (history.length > MAX_SOURCE_RUN_HISTORY_PER_SOURCE) {
    history.splice(0, history.length - MAX_SOURCE_RUN_HISTORY_PER_SOURCE);
  }
  let summary = history.find(item => item?.runId === runId);
  if (!summary) {
    summary = {
      runId,
      announcedAt: null,
      dispatchedAt: null,
      terminalAt: null,
      lastAt: now,
      announcedStatus: null,
      terminalStatus: null,
      warning: null,
      resolvePassCount: 0,
      resolvePasses: [],
      resumeAttemptCount: 0,
      resumeAttempts: [],
    };
    history.push(summary);
    if (history.length > MAX_SOURCE_RUN_HISTORY_PER_SOURCE) {
      history.splice(0, history.length - MAX_SOURCE_RUN_HISTORY_PER_SOURCE);
    }
  }
  summary.lastAt = now;
  return summary;
}

// A UI "searching" announcement may precede actual work by a shared-browser
// queue. Record dispatch beside the real fetch/browser invocation so the
// diagnostics distinguish queued time from provider work without retaining
// query, location, URL, or arbitrary progress text.
export function recordJobSourceDispatch(sourceId, jobRunId = null) {
  // Browser work is serialized, so a cancelled loop can otherwise wake up
  // after its successor has installed replacement telemetry. An explicitly
  // scoped dispatch must belong to the currently live run; never let an old
  // loop append (or evict) history in that replacement record.
  const activeRunId = jobsTelemetry.pipeline?.runId;
  if (jobRunId != null && String(jobRunId) !== String(activeRunId || '')) return false;
  const runId = String(jobRunId || activeRunId || 'unscoped');
  const summary = sourceRunHistorySummary(sourceId, runId);
  if (summary && summary.dispatchedAt == null) summary.dispatchedAt = Date.now();
  return Boolean(summary);
}

// Test-only seam for the stale-browser-run guard. Production callers record
// at the concrete HTTP/browser invocation sites below.
export function __recordJobSourceDispatchForTests(sourceId, jobRunId = null) {
  return recordJobSourceDispatch(sourceId, jobRunId);
}

/**
 * Record source-progress telemetry independently from delivering it to a
 * renderer. Search and post-search Solve calls share this path: otherwise a
 * LinkedIn re-enrichment can finish successfully while the report retains only
 * the initial search's rate-limit error. `updatePipeline` is false for a Solve
 * because the gather stage is already complete; the resolve must not resurrect
 * it as an active search.
 */
export function recordJobSourceProgress(payload = {}, { updatePipeline = true, expectedNodeId = null } = {}) {
  const sid = payload.sourceId;
  if (!sid) return false;
  if (expectedNodeId && jobsTelemetry.nodeId && expectedNodeId !== jobsTelemetry.nodeId) return false;
  // Source-card actions may finish after Reset starts a replacement pipeline.
  // A run-tagged event is never allowed to mutate that replacement's report,
  // including the brief preparing state before it has received a run token.
  if (payload.jobRunId && payload.jobRunId !== jobsTelemetry.pipeline?.runId) return false;

  if (!jobsTelemetry.sourceEventsT0) jobsTelemetry.sourceEventsT0 = Date.now();
  const now = Date.now();
  const arr = jobsTelemetry.sourceEvents[sid] || (jobsTelemetry.sourceEvents[sid] = []);
  const entry = {
    t: now - jobsTelemetry.sourceEventsT0,
    status: payload.status,
    code: payload.warning?.code || null,
    severity: payload.warning?.severity || null,
    detail: payload.detail || null,
  };
  // A paced source emits the same status repeatedly. Fold only consecutive
  // like-for-like events so real failure → Solve → done transitions remain
  // visible in the report trail.
  const last = arr.at(-1);
  if (last && last.status === entry.status && last.code === entry.code && last.severity === entry.severity) {
    last.lastT = entry.t;
    last.repeats = (last.repeats || 1) + 1;
    if (entry.detail) last.detail = entry.detail;
  } else {
    arr.push(entry);
    if (arr.length > 10) arr.shift();
  }

  // Preserve a compact cross-run schedule/throttle receipt even after the
  // next fresh search resets `sourceEvents`. A source can complete cleanly on
  // retry after a prior 429, so only retaining its latest terminal event hid
  // the timing and throttle that caused the first run to appear stuck.
  const runId = String(payload.jobRunId || jobsTelemetry.pipeline?.runId || 'unscoped');
  const summary = sourceRunHistorySummary(sid, runId, now);
  if (summary) {
    if (summary.announcedAt == null) {
      summary.announcedAt = now;
      summary.announcedStatus = payload.status || 'unknown';
    }
    const isTerminalStatus = payload.status === 'done' || payload.status === 'error' || payload.status === 'skipped';
    const recordedTerminal = isTerminalStatus && summary.terminalAt == null;
    // A later Solve/Continue event can share this source run ID, but is often
    // separated from the first terminal result by minutes of user action. It
    // has no new source dispatch receipt, so replacing terminalAt would make
    // the report's `ran` duration falsely include that dwell time. Preserve
    // the first dispatched attempt until a future implementation records a
    // separately attributable recovery dispatch.
    if (recordedTerminal) {
      summary.terminalStatus = payload.status;
      summary.terminalAt = now;
    }
    const warning = payload.warning;
    if (
      recordedTerminal
      && (warning?.code || warning?.severity)
    ) {
      summary.warning = {
        code: String(warning.code || 'unknown').slice(0, 120),
        severity: String(warning.severity || 'unknown').slice(0, 32),
      };
    }
  }

  if (updatePipeline) {
    // A selected source that has not announced yet stays pending until it
    // reports a terminal status; rebuilding from 'searching' events alone
    // dropped queued sources as soon as another source reported.
    const isTerminal = status => status === 'done' || status === 'error' || status === 'skipped';
    const pendingSources = Object.entries(jobsTelemetry.sourceEvents)
      .filter(([, events]) => events?.at(-1)?.status === 'searching')
      .map(([sourceId]) => sourceId);
    const previousPending = Array.isArray(jobsTelemetry.pipeline?.pendingSources) ? jobsTelemetry.pipeline.pendingSources : [];
    for (const sourceId of previousPending) {
      if (pendingSources.includes(sourceId)) continue;
      if (!isTerminal(jobsTelemetry.sourceEvents[sourceId]?.at(-1)?.status)) pendingSources.push(sourceId);
    }
    jobsTelemetry.pipeline = {
      ...(jobsTelemetry.pipeline || {}),
      ts: Date.now(),
      active: true,
      pendingSources,
      lastSource: sid,
    };
  }
  return true;
}

export function ownsCurrentJobTelemetry(nodeId, jobRunId) {
  return !!jobRunId
    && jobsTelemetry.nodeId === nodeId
    && jobsTelemetry.pipeline?.runId === jobRunId;
}

// A source-card action can finish after its hub has Reset or another hub has
// become the process-global telemetry owner. Token-bearing actions must match
// that owner. Legacy untokened actions predate the run fence, so accept them
// only when no tokened pipeline is active; otherwise they would be ambiguous
// and could overwrite the current run's diagnostics.
export function canWriteJobResolveTelemetry(nodeId, jobRunId) {
  return jobRunId
    ? ownsCurrentJobTelemetry(nodeId, jobRunId)
    : !jobsTelemetry.pipeline?.runId;
}

export function __canWriteJobResolveTelemetryForTests(nodeId, jobRunId) {
  return canWriteJobResolveTelemetry(nodeId, jobRunId);
}

// A source receipt is retained for only three runs, so this must remain much
// smaller than the general in-memory resolve timestamp trail. Keep enough
// observations to show a user-visible retry loop while bounding a long-lived
// hub at 36 compact rows per source. The count below intentionally survives
// trimming, so a report can distinguish "twelve retries" from "twelve of many
// retries retained".
export const SOURCE_RUN_RESOLVE_PASS_TRAIL_CAP = 12;

export const SOURCE_RUN_RESOLVE_OUTCOMES = new Set(['completed', 'blocked', 'rejected', 'failed']);

export const SOURCE_RUN_RESOLVE_RECOMMENDATIONS = new Set(['retry', 'skip', 'none']);

export const SOURCE_RUN_RESOLVE_CHECKPOINTS = new Set(['saved', 'unchanged', 'not-ready', 'failed', 'not-applicable']);

export const SOURCE_RUN_RESOLVE_SEVERITIES = new Set(['block', 'throttle', 'warn', 'info']);

// Warning codes are implementation-owned identifiers, not a free-form report
// field. Keep this conservative list so a bad renderer payload cannot smuggle
// job text, a URL, a query, or a location through a nominal diagnostic code.
export const SOURCE_RUN_RESOLVE_WARNING_CODES = new Set([
  'source-health-failed',
  'descriptions-not-fetched',
  'description-appcast-temporary-restriction',
  'description-card-unavailable',
  'description-detail-error',
  'description-detail-challenge',
  'description-detail-hard-block',
  'description-detail-miss',
  'description-detail-navigation',
  'description-detail-session-reset',
  'description-listing-unavailable',
  'description-panel-http-error',
  'description-panel-unresponsive',
  'description-rate-limited',
  'description-recovery-not-ready',
  'description-recovery-persist-failed',
  'description-recovery-snapshot-stale',
  'description-recovery-snapshot-unavailable',
  'description-unsupported-url',
  'resolve-description-incomplete',
  'resolve-detail-enrichment-failed',
  'cloudflare-hard-block',
  'google-apply-links-rate-limited',
]);

export const SOURCE_RUN_RESOLVE_COUNT_FIELDS = [
  'providerRowsLoaded',
  'targeted',
  'attempted',
  'recovered',
  'completeTotal',
  'empty',
  'unavailable',
  'consecutiveNoMatchPasses',
  'consecutiveNoProgressPasses',
];

export function sourceRunResolveCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.min(1_000_000, Math.floor(numeric))
    : null;
}

export function normalizeSourceRunResolvePass(pass = {}, now = Date.now()) {
  const outcome = SOURCE_RUN_RESOLVE_OUTCOMES.has(pass?.outcome)
    ? pass.outcome
    : 'completed';
  const normalized = {
    // The recorder supplies this timestamp. Tests may supply a finite value so
    // retention order can be asserted without a clock seam.
    at: Number.isFinite(Number(pass?.at)) ? Math.max(0, Number(pass.at)) : now,
    outcome,
  };
  for (const field of SOURCE_RUN_RESOLVE_COUNT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(pass, field)) continue;
    const count = sourceRunResolveCount(pass[field]);
    if (count != null) normalized[field] = count;
  }
  const recommendation = pass?.recommendation ?? pass?.recoveryRecommendation;
  if (SOURCE_RUN_RESOLVE_RECOMMENDATIONS.has(recommendation)) normalized.recommendation = recommendation;
  if (SOURCE_RUN_RESOLVE_CHECKPOINTS.has(pass?.checkpoint)) normalized.checkpoint = pass.checkpoint;
  const code = pass?.warning?.code;
  const severity = pass?.warning?.severity;
  if (SOURCE_RUN_RESOLVE_WARNING_CODES.has(code) && SOURCE_RUN_RESOLVE_SEVERITIES.has(severity)) {
    normalized.warning = { code, severity };
  }
  return normalized;
}

/**
 * Append one redacted generic Solve observation to the independently
 * attributable source/run receipt. This must never accept report prose or
 * listing identifiers: only fixed enums, bounded counts, and known warning
 * codes survive normalization.
 */
export function recordJobSourceResolvePass(sourceId, pass = {}, { nodeId = null, jobRunId = null } = {}) {
  if (!canWriteJobResolveTelemetry(nodeId, jobRunId)) return null;
  const runId = String(jobRunId || jobsTelemetry.pipeline?.runId || 'unscoped');
  const summary = sourceRunHistorySummary(sourceId, runId);
  if (!summary) return null;
  const normalized = normalizeSourceRunResolvePass(pass);
  const prior = Array.isArray(summary.resolvePasses) ? summary.resolvePasses : [];
  summary.resolvePassCount = Math.max(0, Number(summary.resolvePassCount) || 0) + 1;
  summary.resolvePasses = [...prior, normalized].slice(-SOURCE_RUN_RESOLVE_PASS_TRAIL_CAP);
  summary.lastAt = normalized.at;
  return normalized;
}

export function __recordJobSourceResolvePassForTests(sourceId, pass = {}, ownership = null) {
  return recordJobSourceResolvePass(sourceId, pass, ownership || {});
}

// The gather stage stamps `sources-blocked` with the sources still waiting on a
// Login/Solve/Skip decision and is never re-stamped afterwards, so a source the
// user then solved left every later report saying the run stopped. Retire the
// resolved source from that stage: when none remain the stage is genuinely
// completed, and `resolvedAfterGather` records WHY it finished late.
export function recordSourceResolvedAfterGather(sourceId) {
  const pipeline = jobsTelemetry.pipeline;
  if (!sourceId || !pipeline || pipeline.phase !== 'sources-blocked') return false;
  const pending = Array.isArray(pipeline.pendingSources)
    ? pipeline.pendingSources.filter(id => typeof id === 'string' && id)
    : [];
  if (!pending.includes(sourceId)) return false;
  const remaining = pending.filter(id => id !== sourceId);
  const resolvedAfterGather = [
    ...(Array.isArray(pipeline.resolvedAfterGather)
      ? pipeline.resolvedAfterGather.filter(id => typeof id === 'string' && id)
      : []),
    sourceId,
  ];
  jobsTelemetry.pipeline = remaining.length === 0
    ? {
      ...pipeline,
      phase: 'completed',
      ts: Date.now(),
      active: false,
      pendingSources: [],
      resolvedAfterGather,
    }
    : { ...pipeline, pendingSources: remaining, resolvedAfterGather };
  return true;
}

// The same stale stage after a Skip: the user finished the run without the
// blocked sources, the terminal receipt is written and cleanup is done, yet the
// gather stage still read `sources-blocked` and every later report called the
// finished run INDETERMINATE. Terminal completion of the SAME hub and run
// retires the stage and keeps which sources the run finished without.
export function recordRunCompletedWithUnfinishedSources(nodeId, runId) {
  const pipeline = jobsTelemetry.pipeline;
  if (!pipeline || pipeline.phase !== 'sources-blocked') return false;
  if (!ownsCurrentJobTelemetry(nodeId, runId)) return false;
  const finishedWithoutSources = Array.isArray(pipeline.pendingSources)
    ? pipeline.pendingSources.filter(id => typeof id === 'string' && id)
    : [];
  jobsTelemetry.pipeline = {
    ...pipeline,
    phase: 'completed',
    ts: Date.now(),
    active: false,
    pendingSources: [],
    finishedWithoutSources,
  };
  return true;
}

// The cap on the in-memory per-source resume trail (jobsTelemetry.resumeAttempts,
// written by recordResumeAttemptTelemetry) and on the report payload built from
// it. Declared here, ahead of both readers, because the durable receipt below
// must use the same number.
export const MAX_RESUME_ATTEMPTS_PER_SOURCE = 12;

// The resume twin of SOURCE_RUN_RESOLVE_PASS_TRAIL_CAP above, and deliberately
// the same number as the in-memory producer's cap: a source receipt that showed
// a different number of Continue clicks than the live trail would read as two
// contradictory observations of the same user action. `resumeAttemptCount`
// survives trimming for the same reason `resolvePassCount` does — so a report
// can distinguish "three clicks" from "three of many clicks retained".
export const SOURCE_RUN_RESUME_ATTEMPT_TRAIL_CAP = MAX_RESUME_ATTEMPTS_PER_SOURCE;

// The resumeState.mode values a source card can actually be showing when the
// user clicks. 'native-login' and 'native-challenge'/'retry-later' are written
// by indeedBrowser.js's warning builders, 'retry-descriptions' by the card's
// own description retry, and 'resume' is the recorder's default for a warning
// that carried a resumeState with no mode at all.
export const SOURCE_RUN_RESUME_MODES = new Set([
  'resume',
  'native-login',
  'native-challenge',
  'retry-later',
  'retry-descriptions',
]);

// Every outcome recorded by a recordResumeAttempt call site in the
// resume-job-source handler. 'cleared' and 'unverified' are both handoff
// states, not terminal ones: the native verification window reported a clean
// first-party tab, or it reported something that is neither a clearance nor an
// observed negative (see NATIVE_CHALLENGE_OBSERVED_NEGATIVES). Either way the
// resume scrape runs next and records its own 'resolved'/'blocked' line, so a
// receipt reads e.g. "unverified -> resolved".
export const SOURCE_RUN_RESUME_OUTCOMES = new Set([
  'resolved',
  'blocked',
  'cleared',
  'logged-in',
  'login-failed',
  'unverified',
  'error',
]);

// The terminal values openNativeIndeedChallengeWindow can settle with
// (electron/ipc/browser/authWindows.js), plus 'launch-error' for the throw the
// handler catches before any result exists. 'unknown' is the explicit marker
// for a missing or unrecognised value: this is the exact field the incident
// turned on, so "the window reported nothing we recognise" must stay readable
// as itself rather than collapsing into one of the real terminals.
export const SOURCE_RUN_RESUME_NATIVE_TERMINALS = new Set([
  'cleared',
  'closed',
  'timeout',
  'hard-block',
  'aborted',
  'app-window-destroyed',
  'launch-error',
  'unknown',
]);

export function normalizeSourceRunResumeAttempt(attempt = {}, now = Date.now()) {
  const mode = String(attempt?.mode || '') || 'resume';
  const outcome = String(attempt?.outcome || '');
  const normalized = {
    // The recorder supplies this timestamp. Tests may supply a finite value so
    // retention order can be asserted without a clock seam.
    at: Number.isFinite(Number(attempt?.at)) ? Math.max(0, Number(attempt.at)) : now,
    // 'unrecognized' is itself an observation, not a guess. Folding an unknown
    // mode into 'resume' would report a plain retry click the user never made,
    // and folding an unknown outcome into 'blocked' would invent a block.
    mode: SOURCE_RUN_RESUME_MODES.has(mode) ? mode : 'unrecognized',
    outcome: SOURCE_RUN_RESUME_OUTCOMES.has(outcome) ? outcome : 'unrecognized',
  };
  if (attempt?.nativeResult != null) {
    const nativeResult = String(attempt.nativeResult);
    normalized.nativeResult = SOURCE_RUN_RESUME_NATIVE_TERMINALS.has(nativeResult)
      ? nativeResult
      : 'unknown';
  }
  return normalized;
}

/**
 * Append one redacted Continue/Log in/Solve observation to the independently
 * attributable source/run receipt.
 *
 * jobsTelemetry.resumeAttempts answers the same question but cannot be relied
 * on: it is wiped when this hub starts its next search, and a report with more
 * than one current hub drops the whole live-telemetry surface, so three
 * Continue clicks could leave no retrievable trace of themselves at all. This
 * receipt survives both, and it inherits the resolve trail's hardening rules
 * verbatim — fixed enums and bounded counts only, never prose, URLs, or job
 * text. `detail` is deliberately not a parameter here: it is free-form and can
 * embed an osascript error string.
 */
export function recordJobSourceResumeAttempt(sourceId, attempt = {}, { nodeId = null, jobRunId = null } = {}) {
  if (!canWriteJobResolveTelemetry(nodeId, jobRunId)) return null;
  const runId = String(jobRunId || jobsTelemetry.pipeline?.runId || 'unscoped');
  const summary = sourceRunHistorySummary(sourceId, runId);
  if (!summary) return null;
  const normalized = normalizeSourceRunResumeAttempt(attempt);
  const prior = Array.isArray(summary.resumeAttempts) ? summary.resumeAttempts : [];
  summary.resumeAttemptCount = Math.max(0, Number(summary.resumeAttemptCount) || 0) + 1;
  summary.resumeAttempts = [...prior, normalized].slice(-SOURCE_RUN_RESUME_ATTEMPT_TRAIL_CAP);
  summary.lastAt = normalized.at;
  return normalized;
}

export function __recordJobSourceResumeAttemptForTests(sourceId, attempt = {}, ownership = null) {
  return recordJobSourceResumeAttempt(sourceId, attempt, ownership || {});
}

// A rejected fresh start temporarily owns global diagnostics while it performs
// preflight. Restore the previous snapshot only if that same rejected token is
// still current: an overlapping later search may have legitimately claimed it
// before the failed start learns about its manifest conflict.
export function restoreJobsTelemetryIfCurrentRun(nodeId, jobRunId, snapshot) {
  if (!ownsCurrentJobTelemetry(nodeId, jobRunId)) return false;
  Object.assign(jobsTelemetry, snapshot);
  return true;
}

export function __restoreJobsTelemetryIfCurrentRunForTests(nodeId, jobRunId, snapshot) {
  return restoreJobsTelemetryIfCurrentRun(nodeId, jobRunId, snapshot);
}

// Durable recovery data, not this process's telemetry, authorizes a source
// card after restart or after another canvas became the in-memory owner.
export async function jobSourceActionAuthorization(canvasFilePath, nodeId, jobRunId) {
  if (!jobRunId) {
    return {
      authorized: !canvasFilePath && canWriteJobResolveTelemetry(nodeId, jobRunId),
      reason: 'missing-run-id',
    };
  }
  // Unsaved cards cannot survive a restart and are fenced by their renderer
  // run token. Do not make their action depend on unrelated process-global
  // diagnostics: another hub may legitimately become that owner while this
  // unsaved card is paused. Untagged legacy actions above remain fail-closed.
  if (!canvasFilePath) {
    return {
      authorized: typeof nodeId === 'string' && nodeId.trim().length > 0,
      reason: 'unsaved-canvas',
    };
  }
  const state = await readRunState(canvasFilePath, Date.now(), { nodeId });
  const ownsRun = !!state?.manifest
    && state.manifest.runId === jobRunId
    && state.manifest.inputs?.nodeId === nodeId;
  if (!ownsRun) return { authorized: false, reason: 'stale-run' };
  // The provider boundary only admits an in-flight card click to the shared
  // renderer lane. A source mutation itself must wait for the normal
  // post-filter/recovery checkpoint, represented by `gathered`. In
  // particular, never let an early provider ledger become a description
  // recovery universe: it has not passed age/history/preference filtering.
  if (state.manifest.stage === 'gathered') return { authorized: true, reason: 'gathered' };
  if (providerGatheredAtForManifest(state.manifest) != null) {
    return { authorized: false, reason: 'provider-boundary-awaiting-final-checkpoint' };
  }
  return { authorized: false, reason: 'not-gathered' };
}

export async function canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId) {
  return (await jobSourceActionAuthorization(canvasFilePath, nodeId, jobRunId)).authorized;
}

export async function __canPerformJobSourceActionForTests(canvasFilePath, nodeId, jobRunId) {
  return canPerformJobSourceAction(canvasFilePath, nodeId, jobRunId);
}

export async function __jobSourceActionAuthorizationForTests(canvasFilePath, nodeId, jobRunId) {
  return jobSourceActionAuthorization(canvasFilePath, nodeId, jobRunId);
}

// A source's `resolves` row is last-write-wins, so N Solve passes on one source
// leave exactly ONE row and get counted as one attempt. LinkedIn escaped that
// only because it has a separate bounded trail; every other source reported "1"
// no matter how many times it actually ran. A real run showed "2 post-completion
// recovery attempts" while Google alone had been re-walked ~13 times.
// `cumulativeMergeNet` below already establishes the rule this follows: session
// accounting must survive the row being replaced. Bounded — this is diagnostic
// detail, not a ledger.
export const RESOLVE_PASS_TRAIL_CAP = 50;

export function nextResolvePassTrail(previous) {
  const prior = Array.isArray(previous?.passTimestamps) ? previous.passTimestamps : [];
  return [...prior, Date.now()].slice(-RESOLVE_PASS_TRAIL_CAP);
}

export function recordLinkedinResolveAttempt(sourceId, extra = {}, ownership = null) {
  if (!canWriteJobResolveTelemetry(ownership?.nodeId, ownership?.jobRunId)) return null;
  const previous = jobsTelemetry.resolves[sourceId];
  const snapshot = {
    ts: Date.now(),
    kind: 'linkedin-reenrich',
    // The latest attempt replaces the detailed resolve row, but its merge total
    // is session accounting and must survive. A rate-limited source commonly
    // needs several Solve passes; dropping the earlier net deltas made a healthy
    // 3→7→15→52→54 run read as "5 gathered, 49 carried over".
    cumulativeMergeNet: Number(previous?.cumulativeMergeNet) || 0,
    hasMergeTelemetry: previous?.hasMergeTelemetry === true,
    passTimestamps: nextResolvePassTrail(previous),
    ...extra,
    // A resolve row can survive several attempts, but it cannot be allowed to
    // cross a fresh-search reset into another receipt.  This token is internal
    // provenance, never persisted verbatim in the receipt's recovery aggregate.
    runId: ownership?.jobRunId || previous?.runId || null,
  };
  jobsTelemetry.resolves[sourceId] = snapshot;
  return snapshot;
}

/** Attach the renderer's real queue delta without losing earlier Solve passes. */
export function recordResolveMergeOutcome(sourceId, merge = {}, ownership = null) {
  if (!canWriteJobResolveTelemetry(ownership?.nodeId, ownership?.jobRunId)) return null;
  const resolve = jobsTelemetry.resolves[sourceId];
  if (!sourceId || !resolve) return null;
  // Older in-memory rows did not retain their run token.  Bind one only while
  // the current ownership fence authorizes this event; never let a stale row
  // contribute a renderer delta to a different run's terminal receipt.
  if (!resolve.runId && ownership?.jobRunId) resolve.runId = ownership.jobRunId;
  if (ownership?.jobRunId && resolve.runId !== ownership.jobRunId) return null;
  const normalized = {
    replacedExisting: Number(merge.replacedExisting) || 0,
    fresh: Number(merge.fresh) || 0,
    pendingBefore: Number(merge.pendingBefore) || 0,
    pendingAfter: Number(merge.pendingAfter) || 0,
  };
  const net = normalized.pendingAfter - normalized.pendingBefore;
  resolve.merge = normalized;
  resolve.cumulativeMergeNet = (Number(resolve.cumulativeMergeNet) || 0) + net;
  resolve.hasMergeTelemetry = true;
  return resolve;
}

// Append one Continue/Log in/Solve resume attempt to the capped per-source
// trail (see jobsTelemetry.resumeAttempts). `mode` is the resumeState.mode the
// card was showing when the user acted — kept even after resume-job-source
// clears it internally, so the report can tell a native-login click from a
// plain retry-later click. Mirrors the linkedinEnrich cap (see
// recordLinkedinEnrichPass) — newest last, capped at 12.
// The cap is MAX_RESUME_ATTEMPTS_PER_SOURCE, declared beside the durable
// source/run receipt that has to agree with it.
export function recordResumeAttemptTelemetry(sourceId, mode, outcome, detail, ownership = null) {
  if (!sourceId || !canWriteJobResolveTelemetry(ownership?.nodeId, ownership?.jobRunId)) return;
  const list = jobsTelemetry.resumeAttempts[sourceId] || (jobsTelemetry.resumeAttempts[sourceId] = []);
  list.push({ t: Date.now(), mode: mode || 'resume', outcome, detail: String(detail || '').slice(0, 200) });
  if (list.length > MAX_RESUME_ATTEMPTS_PER_SOURCE) list.shift();
}

// Narrow test seam for the ownership-sensitive resume trail. Handler-local
// wrappers always bind their own node/run tuple; this proves the recorder
// accepts the current tuple and rejects a late foreign one.
export function __recordResumeAttemptForTests(sourceId, mode, outcome, detail, ownership) {
  return recordResumeAttemptTelemetry(sourceId, mode, outcome, detail, ownership);
}

// The Indeed browser keeps a bounded per-row enrichment trail. Aggregate it at
// the resume boundary so a post-challenge pass retains more than the final
// extracted count: diagnostics can distinguish a normal card-panel recovery
// from re-enrichment that remained blank/challenged/unavailable. No listing
// text is copied into telemetry.
export function summarizeIndeedResumeEnrichment(jobs) {
  const stages = {};
  let rowsWithAttempts = 0;
  let attempts = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const trail = Array.isArray(job?._enrichAttempts) ? job._enrichAttempts : [];
    if (trail.length > 0) rowsWithAttempts += 1;
    for (const attempt of trail) {
      const stage = String(attempt?.stage || 'unknown').slice(0, 32);
      const outcome = String(attempt?.outcome || 'unknown').slice(0, 32);
      const summary = stages[stage] || (stages[stage] = { attempted: 0, recovered: 0, short: 0, blank: 0, challenge: 0, unavailable: 0, error: 0, other: 0 });
      summary.attempted += 1;
      if (Object.hasOwn(summary, outcome)) summary[outcome] += 1;
      else summary.other += 1;
      attempts += 1;
    }
  }
  return { rowsWithAttempts, attempts, stages };
}

// The openNativeIndeedChallengeWindow outcomes that are DIRECT NEGATIVE
// OBSERVATIONS rather than the mere absence of a positive one. Only these may
// hard-block a "Continue" click:
//   'hard-block'           the observer read an Indeed/Cloudflare block page, or
//                          a wall whose URL and title never changed at all.
//   'aborted'              the AbortSignal has already fired, so the resume
//                          scrape's own withSharedProfileLock(..., signal) would
//                          reject immediately and record that rejection as a
//                          scrape error the user never caused.
//   'app-window-destroyed' the renderer that asked for this is gone; there is
//                          nobody left to receive rows a scrape would find.
// Everything else — 'closed', 'timeout', or an unrecognised/missing value — is
// INCONCLUSIVE and must fall through to the resume scrape. 'closed' is produced
// by nativeIndeedChallengeExitDisposition (electron/ipc/browser/authWindows.js)
// with postCloseReason 'no-affirmative-clean-tab': the AppleScript tab poll
// never made a positive clean-page observation before the window exited. That
// is exactly what a wholesale poll failure also looks like — getNativeChromeTabs
// returns a single [{ url: '', title: '', error }] row when the Apple event is
// denied — and what a user who really did solve the check and then closed the
// window produces. Hard-blocking it told that user "no automated retry was
// attempted" while their clearance sat unused in the shared profile. The resume
// scrape is the only authoritative proof available here and needs no new
// plumbing: resumeState already carries { mode, challengeUrl, remainingQueries,
// startPage }.
export const NATIVE_CHALLENGE_OBSERVED_NEGATIVES = new Set(['hard-block', 'aborted', 'app-window-destroyed']);

/**
 * Classify one openNativeIndeedChallengeWindow terminal into the decision the
 * resume handler acts on.
 *
 *   'blocked'    a direct negative observation (the set above): return a
 *                blocking warning rather than spend a scrape on a wall the
 *                observer actually read.
 *   'cleared'    the observer made an affirmative clean first-party tab
 *                observation.
 *   'unverified' everything else, INCLUDING an empty or unrecognised terminal —
 *                the absence of a positive observation, never a negative one.
 *                Falls through to the resume scrape, the only authority that can
 *                settle whether the user's verification landed.
 *
 * Exported because the handler below calls it: the test asserts the shipped
 * decision over the whole enum instead of re-reading the shape of the branch's
 * source text, which a reformat would break and a revert that moved the same
 * hard block into a helper would still pass.
 */
export function nativeChallengeTerminalDisposition(outcome) {
  const terminal = String(outcome || '');
  if (NATIVE_CHALLENGE_OBSERVED_NEGATIVES.has(terminal)) return 'blocked';
  return terminal === 'cleared' ? 'cleared' : 'unverified';
}

// Stamp the last-observed Indeed scrape session preflight (see
// jobsTelemetry.indeedSession). sessionDiagnostics comes straight from
// fetchIndeedListingsBrowser's return value — pass it through as-is rather
// than re-deriving any of it here, so this can never disagree with what the
// extractor itself observed.
export function stampIndeedSessionTelemetry(sessionDiagnostics, ownership = null) {
  if (!sessionDiagnostics
    || (ownership && !canWriteJobResolveTelemetry(ownership.nodeId, ownership.jobRunId))) return;
  jobsTelemetry.indeedSession = { ts: Date.now(), ...sessionDiagnostics };
}

/** Whether an initial Indeed result requires a later user-operated native handoff. */
export function indeedWarningRequiresManualVerification(warning) {
  return warning?.resumeState?.mode === 'native-challenge';
}

/**
 * Convert the scraper's own preflight into a fresh, cache-safe session verdict.
 * The authenticated account page / PPID observation is stronger than an old
 * startup verifier result retained after Cloudflare made that verifier
 * inconclusive. No other scrape outcome is promoted to connected.
 */
export function authenticatedIndeedScrapeStatus(sessionDiagnostics, warning) {
  if (!sessionDiagnostics || warning?.code === 'needs-login') return null;
  // The preflight's OWN verdict is the only thing allowed to promote a session
  // to connected. classifyIndeedSessionPreflight (electron/extractors/indeedBrowser.js)
  // evaluates the challenge signal BEFORE any auth inference, so a Cloudflare
  // wall classifies as 'challenge' while the shared profile's cookie jar can
  // still hold a PPID left over from an older — possibly dead — session.
  // Accepting that bare cookie stamped "freshly observed an authenticated
  // session", complete with a synthesized 'scrape-preflight' verify trace, in
  // the same second the source failed with scrape-failed; the bug report then
  // showed an authenticated-session claim contradicting the failure beside it.
  if (sessionDiagnostics.preflightStatus !== 'authenticated') return null;
  const url = String(sessionDiagnostics.landedUrl || 'https://myjobs.indeed.com/saved');
  const signal = sessionDiagnostics.hasPPID === true ? 'PPID auth cookie' : 'authenticated account page';
  return {
    lastReason: `Indeed scrape preflight freshly observed an authenticated session (${signal}).`,
    lastTrace: {
      target: url,
      finalUrl: url,
      status: 'scrape-preflight',
      loginSignal: signal,
      checks: [{ target: url, finalUrl: url, status: 'scrape-preflight', loginSignal: signal }],
    },
  };
}

// BUG 5: a native login can mark the Indeed account "connected" in the
// accounts.js cache, but only the scrape itself proves whether that session
// is still alive. When the scrape's own warning says the session was not
// authenticated, invalidate the cache so Settings and the bug report stop
// asserting a connection the scrape just disproved. Never invalidate on any
// other warning code — a Cloudflare block or a launch failure says nothing
// about the account session.
export async function invalidateIndeedSessionIfNeedsLogin(warning) {
  if (warning?.code !== 'needs-login') return;
  await invalidatePlatformSessionStatus('indeed', warning.evidence || 'Indeed scrape returned needs-login.');
  // The scrape just disproved the session, so a login this process watched
  // finish moments ago no longer describes the profile. The cache invalidation
  // and the dedupe stamp must move together — see forgetIndeedLoginConfirmation.
  forgetIndeedLoginConfirmation('an Indeed scrape returned needs-login');
}

export async function syncIndeedSessionStatusFromScrape(sessionDiagnostics, warning, { telemetryOwnership = null } = {}) {
  // The account-status cache describes the real shared browser profile and is
  // useful even for a durable recovery owned by another canvas. Only the
  // process-global diagnostic stamp is ownership-fenced.
  stampIndeedSessionTelemetry(sessionDiagnostics, telemetryOwnership);
  if (warning?.code === 'needs-login') {
    await invalidateIndeedSessionIfNeedsLogin(warning);
    return;
  }
  const fresh = authenticatedIndeedScrapeStatus(sessionDiagnostics, warning);
  if (fresh) await writeStatusCache('indeed', true, fresh);
}

/**
 * The observation to add to the "Not logged in" search-preflight rejection when
 * this process's LAST look at the Indeed session was a challenge page.
 *
 * authenticatedIndeedScrapeStatus promotes a session to connected only on its
 * own 'authenticated' preflight verdict (a bare leftover PPID cookie is not one
 * — that promotion is the bug it exists to prevent). A profile that is genuinely
 * signed in but served an interstitial on every preflight therefore never
 * refreshes its cached status and eventually reads as not connected. Refusing
 * the search is still right: nothing here observed a live session. But the bare
 * copy asserted a state ("not logged in") that contradicted the preflightStatus
 * printed beside it in the report and steered the user at a login they may not
 * need. State what was observed and stop there — never why the challenge
 * appeared, and never whether the account is in fact signed in.
 */
export function indeedPreflightObservationNote(notLoggedInSourceIds = []) {
  if (!notLoggedInSourceIds.includes('indeed')) return '';
  const session = jobsTelemetry.indeedSession;
  if (session?.preflightStatus !== 'challenge') return '';
  const reason = session.preflightReason ? ` (${session.preflightReason})` : '';
  const observedAt = Number(session.ts);
  const ageMs = Number.isFinite(observedAt) ? Date.now() - observedAt : NaN;
  const when = Number.isFinite(ageMs) && ageMs >= 0 ? `${Math.round(ageMs / 1000)}s ago` : 'earlier this session';
  return `Indeed's last scrape preflight ${when} was observed as a challenge page${reason}, not a sign-in page; a challenge says nothing either way about the account session, so the cached connection status could not be refreshed from it. `;
}

// A fresh search or direct re-score starts a source-hub-owned pipeline. Clear
// any prior board attribution even when the same hub is re-scored: until a
// board combines the new scores, the previous board result belongs to the old
// scoring run and must not ride along in diagnostics.
export function recordJobsSourceScope(nodeId, windowId) {
  jobsTelemetry.nodeId = nodeId || null;
  jobsTelemetry.boardNodeId = null;
  jobsTelemetry.bucketing = null;
  jobsTelemetry.windowId = windowId ?? null;
}

// Bucketing is display work owned by a Job Board. It must never replace the
// source hub identity stamped by search/score. If bucketing is invoked without
// a preceding source stage in this process (for example a persisted board-only
// combine after restart), use its sender only to scope that standalone board
// telemetry to the correct window.
export function recordJobsBoardScope(nodeId, windowId) {
  jobsTelemetry.boardNodeId = nodeId || null;
  if (!jobsTelemetry.nodeId) jobsTelemetry.windowId = windowId ?? null;
}

// Cumulative descriptions enriched on the CURRENT stealth-browser generation,
// reset when the browser relaunches (generation changes). This is context for
// a report, not a limit discriminator: later passes normally receive a smaller
// remaining pool, so a falling per-pass yield cannot establish session scope.
let lkEnrichGen = null;

let lkEnrichedThisGen = 0;

// Append one LinkedIn enrichment-pass record to the capped trail (see
// jobsTelemetry.linkedinEnrich). ipOk distinguishes "ran on IP x" from "egress
// lookup returned null" — the latter means the same-IP VPN guard can't function.
// browserGen ties the pass to a specific browser process; attempted and
// remainingBefore make a shrinking work pool explicit in the diagnostic trail.
export function recordLinkedinEnrichPass(entry) {
  if (entry?.jobRunId && !ownsCurrentJobTelemetry(entry.nodeId, entry.jobRunId)) return false;
  const gen = entry.browserGen ?? null;
  let before = lkEnrichedThisGen;
  if (gen != null) {
    // New browser process ⇒ a relaunch reset any browser/session-scoped limit.
    if (gen !== lkEnrichGen) { lkEnrichGen = gen; lkEnrichedThisGen = 0; before = 0; }
    lkEnrichedThisGen += (entry.enriched || 0);
  }
  jobsTelemetry.linkedinEnrich.push({
    ts: Date.now(), ...entry,
    browserLifetimeBefore: before, browserLifetimeAfter: lkEnrichedThisGen,
  });
  // Keep the last dozen — enough to see the cross-Solve IP/browser trend across a
  // test session without unbounded growth.
  if (jobsTelemetry.linkedinEnrich.length > 12) jobsTelemetry.linkedinEnrich.shift();
}
