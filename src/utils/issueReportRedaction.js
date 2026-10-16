// Preference inputs are user-authored free text, while the candidate pool
// contains full listings and evidence quotes. Neither belongs in a report.
import { summarizeJobScoringIntegrity } from './jobScoringContract.js';

// A hub can live inside a folder (a sidebar module dropped onto a group, or
// spawned while a sub-canvas is open), so redaction has to follow
// `data.canvasData.nodes` down. The depth cap bounds a corrupt/cyclic canvas;
// past it the nested nodes are dropped rather than passed through unredacted,
// and the count of what was dropped is stated so the payload never reads as a
// complete canvas.
const MAX_NESTED_CANVAS_DEPTH = 12;
const INTERVIEW_HELPER_CAREER_MODES = new Set(['job-search', 'import']);
const INTERVIEW_HELPER_COMPILATION_STATUSES = new Set(['compiling', 'failed', 'approved']);
const INTERVIEW_HELPER_PREPARATION_STATUSES = new Set(['preparing', 'failed']);
const INTERVIEW_HELPER_CLEANUP_KINDS = new Set(['career', 'preparation']);
const INTERVIEW_HELPER_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const INTERVIEW_HELPER_BRIEF_ID_RE = /^[a-f0-9]{64}$/u;
const INTERVIEW_HELPER_MAX_STEPS = 6;
const INTERVIEW_HELPER_MAX_RETIREMENT_RECEIPTS = 32;

function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype ? value : null;
}

function safeInterviewHelperCount(value, maximum) {
  return Array.isArray(value) && value.length <= maximum ? value.length : null;
}

function safeInterviewHelperStatus(value, allowed) {
  const record = plainRecord(value);
  return record && allowed.has(record.status) ? record.status : null;
}

function safeInterviewHelperCleanup(value) {
  const record = plainRecord(value);
  if (!record || Object.keys(record).sort().join(',') !== 'kind,runId,status,version'
    || record.version !== 1 || !INTERVIEW_HELPER_CLEANUP_KINDS.has(record.kind)
    || record.status !== 'failed' || !INTERVIEW_HELPER_RUN_ID_RE.test(record.runId || '')) return null;
  // Run identifiers can contain user-derived context. Keep only the bounded
  // lifecycle enum needed to diagnose a stuck cleanup.
  return { kind: record.kind, status: 'failed' };
}

function safeInterviewHelperRetirementCount(value) {
  if (!Array.isArray(value) || value.length > INTERVIEW_HELPER_MAX_RETIREMENT_RECEIPTS) return 0;
  let valid = 0;
  for (const candidate of value) {
    const receipt = plainRecord(candidate);
    const keys = receipt && Object.keys(receipt).sort().join(',');
    const legacyKeys = 'cancellationPending,cancellationReason,retirementPending,retirementReason,runId';
    const currentKeys = `${legacyKeys},updatedAt`;
    if (!receipt || (keys !== legacyKeys && keys !== currentKeys)
      || !INTERVIEW_HELPER_RUN_ID_RE.test(receipt.runId || '')
      || receipt.retirementPending !== true || receipt.retirementReason !== 'node-deleted'
      || typeof receipt.cancellationPending !== 'boolean' || receipt.cancellationReason !== 'node-deleted'
      || (Object.hasOwn(receipt, 'updatedAt') && (!Number.isSafeInteger(receipt.updatedAt) || receipt.updatedAt < 0))) continue;
    valid += 1;
  }
  return valid;
}

function redactInterviewHelperNode(node, depth) {
  const data = plainRecord(node.data) || {};
  const careerFilesCount = safeInterviewHelperCount(data.interviewHelperCareerFilenames, 100);
  const plan = plainRecord(data.interviewHelperLockedPlan);
  const planStepsCount = plan?.status === 'supported'
    ? safeInterviewHelperCount(plan.steps, INTERVIEW_HELPER_MAX_STEPS) : null;
  const currentStep = Number.isSafeInteger(data.interviewHelperCurrentStep)
    && data.interviewHelperCurrentStep >= 0 && planStepsCount !== null
    && data.interviewHelperCurrentStep < planStepsCount ? data.interviewHelperCurrentStep : null;
  const preparation = plainRecord(data.interviewHelperPreparation);
  const preparationStatus = safeInterviewHelperStatus(preparation, INTERVIEW_HELPER_PREPARATION_STATUSES);
  // Completed briefs have no lifecycle status. Do not infer readiness from an
  // arbitrary object: a minimal versioned opaque identifier is required, but
  // neither the identifier nor any brief content reaches the report.
  const preparationReady = !!(preparation && preparation.version === 1
    && INTERVIEW_HELPER_BRIEF_ID_RE.test(preparation.briefId || '')
    && INTERVIEW_HELPER_BRIEF_ID_RE.test(data.interviewHelperPreparationRecordId || '')
    && !Object.hasOwn(preparation, 'status'));
  const compilationStatus = safeInterviewHelperStatus(data.interviewHelperCareerCompilation, INTERVIEW_HELPER_COMPILATION_STATUSES);
  const nestedCanvas = plainRecord(data.canvasData);
  const safeData = {
    ...(typeof data.locked === 'boolean' ? { locked: data.locked } : {}),
    ...(INTERVIEW_HELPER_CAREER_MODES.has(data.interviewHelperCareerMode) ? { interviewHelperCareerMode: data.interviewHelperCareerMode } : {}),
    ...(careerFilesCount !== null ? { interviewHelperCareerFilesCount: careerFilesCount } : {}),
    interviewHelperHasJobUrl: typeof data.interviewHelperJobUrl === 'string' && data.interviewHelperJobUrl.length > 0,
    interviewHelperHasApplicationBundle: !!plainRecord(data.interviewHelperApplicationBundle),
    ...(compilationStatus ? { interviewHelperCareerCompilationStatus: compilationStatus } : {}),
    ...(preparationStatus ? { interviewHelperPreparationStatus: preparationStatus } : {}),
    ...(preparationReady ? { interviewHelperPreparationReady: true } : {}),
    ...(planStepsCount !== null ? {
      interviewHelperPlanStatus: 'supported',
      interviewHelperPlanStepsCount: planStepsCount,
      ...(currentStep !== null ? { interviewHelperCurrentStep: currentStep } : {}),
    } : {}),
    ...(safeInterviewHelperCleanup(data.interviewHelperManualAiCleanup)
      ? { interviewHelperManualAiCleanup: safeInterviewHelperCleanup(data.interviewHelperManualAiCleanup) } : {}),
    ...(Array.isArray(data.interviewHelperManualAiRetirementReceipts)
      ? { interviewHelperManualAiRetirementReceiptsCount: safeInterviewHelperRetirementCount(data.interviewHelperManualAiRetirementReceipts) } : {}),
    // Only descendants are needed for topology diagnostics. Do not propagate
    // arbitrary nested-canvas metadata from an Interview Helper card.
    ...(Array.isArray(nestedCanvas?.nodes) ? { canvasData: { nodes: nestedCanvas.nodes } } : {}),
  };
  // Unlike ordinary canvas cards, every Interview Helper data field either
  // points to a private artifact or can contain user/career/job text. Build a
  // positive allow-list instead of spreading its data, then recurse normally.
  return redactNestedCanvas({ ...node, data: safeData }, depth);
}

function redactNestedCanvas(node, depth) {
  const canvasData = node?.data?.canvasData;
  if (!Array.isArray(canvasData?.nodes)) return node;
  const overDepth = depth >= MAX_NESTED_CANVAS_DEPTH;
  return {
    ...node,
    data: {
      ...node.data,
      canvasData: {
        ...canvasData,
        nodes: overDepth ? [] : canvasData.nodes.map((child) => redactNode(child, depth + 1)),
        ...(overDepth ? { nestedNodesOmitted: canvasData.nodes.length } : {}),
      },
    },
  };
}

function redactNode(node, depth) {
  if (!node?.data) return node;

  if (node.type === 'interviewhelper') return redactInterviewHelperNode(node, depth);

  if (node.type !== 'jobhub') {
    if (Array.isArray(node.data.scoredJobs)) {
      const { scoredJobs, ...restData } = node.data;
      return redactNestedCanvas({ ...node, data: { ...restData, scoredJobsCount: scoredJobs.length } }, depth);
    }
    return redactNestedCanvas(node, depth);
  }

  const { scoredJobs, preferenceCandidatePool, ...restData } = node.data;
  for (const key of [
    'jobPreferences', 'activeJobPreferences', 'pendingJobPreferences',
    'jobPreferencePlan', 'pendingJobPreferencePlan',
    'jobPreferencesInterpretation', 'pendingJobPreferencesInterpretation',
    'preferenceEvaluation',
  ]) delete restData[key];
  return redactNestedCanvas({
    ...node,
    data: {
      ...restData,
      ...(Array.isArray(scoredJobs) ? { scoredJobsCount: scoredJobs.length } : {}),
      scoringIntegrity: summarizeJobScoringIntegrity(node.data),
      ...(Array.isArray(preferenceCandidatePool) ? { preferenceCandidatePoolCount: preferenceCandidatePool.length } : {}),
    },
  }, depth);
}

// Not the recursive entry point itself: callers pass this straight to
// `Array.prototype.map`, which would feed the array index in as the depth.
export function redactNodeForIssueReport(node) {
  return redactNode(node, 0);
}
