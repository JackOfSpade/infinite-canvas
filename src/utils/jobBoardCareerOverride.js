// A Board career override is an independently compiled, approved career
// snapshot owned by one Job Board. Its cards use it for application bundles
// instead of their per-card career pin. This module is the pure renderer-side
// model: it never talks to Electron and fails closed on any malformed shape so
// a corrupt canvas cannot pin applications to an unapproved snapshot.
import {
  beginCareerImportCompilation,
  approveCareerImportCompilation,
  failCareerImportCompilation,
} from './jobCareerCompilationReceipt.js';

export const JOB_BOARD_CAREER_OVERRIDE_VERSION = 1;
// Deliberately distinct from the Board's own `job-board:` combine runs so an
// override compile can never be mistaken for (or retired as) a combine run.
export const JOB_BOARD_CAREER_OVERRIDE_RUN_PREFIX = 'job-board-career:';

// Keep synchronized with InterviewHelperNode's RUN_ID_RE; never widen.
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SNAPSHOT_ID_RE = /^[a-f0-9]{64}$/u;
const MAX_FILES = 32;
const MAX_FILE_NAME_LENGTH = 180;
const MAX_RETIRE_PENDING = 32;
const MAX_ERROR_LENGTH = 1000;
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

function isPlainRecord(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && !FORBIDDEN_KEYS.some(key => Object.hasOwn(value, key));
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function snapshotId(value) {
  return typeof value === 'string' && SNAPSHOT_ID_RE.test(value) ? value : null;
}

function safeTime(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function isJobBoardCareerOverrideRunId(value) {
  return typeof value === 'string'
    && RUN_ID_RE.test(value)
    && value.startsWith(JOB_BOARD_CAREER_OVERRIDE_RUN_PREFIX);
}

// A run id that may belong to a Board Combine/scan transaction. Career
// override runs share the Board's node id but never own Board-run state.
export function isBoardCombineManualAiRunId(runId) {
  return typeof runId === 'string'
    && runId.length > 0
    && !isJobBoardCareerOverrideRunId(runId);
}

// Patch that removes career override run ids wrongly adopted into Board-run
// recovery state (manualAiResume, cleanup receipts, cancellation run ids).
// Returns null when nothing needs cleaning; never touches the override record,
// boardScanResume, or any non-career id.
export function careerOverrideBoardMarkerCleanup(data) {
  if (!data || typeof data !== 'object') return null;
  const patch = {};
  if (isJobBoardCareerOverrideRunId(data.manualAiResume?.runId)) {
    patch.manualAiResume = null;
  }
  if (Array.isArray(data.manualAiCleanupReceipts)) {
    const kept = data.manualAiCleanupReceipts.filter(
      receipt => !isJobBoardCareerOverrideRunId(receipt?.runId),
    );
    if (kept.length !== data.manualAiCleanupReceipts.length) patch.manualAiCleanupReceipts = kept;
  }
  const cancellation = data.boardCancellation;
  if (cancellation && typeof cancellation === 'object' && Array.isArray(cancellation.manualAiRunIds)) {
    const kept = cancellation.manualAiRunIds.filter(runId => !isJobBoardCareerOverrideRunId(runId));
    if (kept.length !== cancellation.manualAiRunIds.length) {
      patch.boardCancellation = { ...cancellation, manualAiRunIds: kept };
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function entropy() {
  const uuid = globalThis.crypto?.randomUUID?.();
  const raw = typeof uuid === 'string' && uuid
    ? uuid
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return raw.replace(/:/gu, '-');
}

export function createJobBoardCareerOverrideRunId(nodeId) {
  return `${JOB_BOARD_CAREER_OVERRIDE_RUN_PREFIX}${nodeId}:${entropy()}`;
}

function normalizeFileNames(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(name => typeof name === 'string' && name.trim())
    .slice(0, MAX_FILES)
    .map(name => name.slice(0, MAX_FILE_NAME_LENGTH));
}

function normalizeFilePaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) return null;
  if (!value.every(path => typeof path === 'string' && path.trim())) return null;
  return [...value];
}

function normalizeRetirePending(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isJobBoardCareerOverrideRunId))].slice(-MAX_RETIRE_PENDING);
}

function normalizeApproved(value) {
  if (!isPlainRecord(value)) return null;
  const id = snapshotId(value.careerSnapshotId);
  const generation = nonEmptyText(value.generation);
  if (!id || !generation) return null;
  return {
    careerSnapshotId: id,
    generation,
    fileNames: normalizeFileNames(value.fileNames),
    approvedAt: safeTime(value.approvedAt),
    profileFingerprint: typeof value.profileFingerprint === 'string' ? value.profileFingerprint : null,
  };
}

function normalizePending(value) {
  if (!isPlainRecord(value)) return null;
  if (value.version !== 1 || !['compiling', 'failed'].includes(value.status)) return null;
  const generation = nonEmptyText(value.generation);
  const attemptId = nonEmptyText(value.attemptId);
  if (!generation || !attemptId || !isJobBoardCareerOverrideRunId(value.manualAiRunId)) return null;
  const filePaths = normalizeFilePaths(value.filePaths);
  if (!filePaths) return null;
  const pending = {
    version: 1,
    generation,
    attemptId,
    status: value.status,
    manualAiRunId: value.manualAiRunId,
    startedAt: safeTime(value.startedAt),
    filePaths,
    fileNames: normalizeFileNames(value.fileNames),
  };
  if (value.status === 'failed') {
    pending.error = String(value.error || 'Failed to compile career files').slice(0, MAX_ERROR_LENGTH);
    pending.failedAt = safeTime(value.failedAt);
  }
  return pending;
}

function finalize({ approved = null, pending = null, retirePending = [] }) {
  const retire = normalizeRetirePending(retirePending);
  if (!approved && !pending && retire.length === 0) return null;
  return {
    version: JOB_BOARD_CAREER_OVERRIDE_VERSION,
    approved,
    pending,
    retirePending: retire,
  };
}

export function normalizeJobBoardCareerOverride(value) {
  if (!isPlainRecord(value) || value.version !== JOB_BOARD_CAREER_OVERRIDE_VERSION) return null;
  return finalize({
    approved: normalizeApproved(value.approved),
    pending: normalizePending(value.pending),
    retirePending: normalizeRetirePending(value.retirePending),
  });
}

function recordOf(boardData) {
  return isPlainRecord(boardData) ? normalizeJobBoardCareerOverride(boardData.jobBoardCareerOverride) : null;
}

export function approvedJobBoardCareerOverrideSnapshotId(boardData) {
  return recordOf(boardData)?.approved?.careerSnapshotId ?? null;
}

export function beginJobBoardCareerOverride(boardData, {
  nodeId,
  filePaths,
  fileNames,
  now = Date.now(),
} = {}) {
  if (typeof nodeId !== 'string' || !nodeId) return null;
  const paths = normalizeFilePaths(filePaths);
  if (!paths || !Array.isArray(fileNames) || fileNames.length !== paths.length) return null;
  const current = recordOf(boardData);
  if (current?.pending?.status === 'compiling') return null;
  const runId = createJobBoardCareerOverrideRunId(nodeId);
  if (!isJobBoardCareerOverrideRunId(runId)) return null;
  const receipt = beginCareerImportCompilation({ generation: runId, manualAiRunId: runId });
  if (!receipt) return null;
  const retirePending = [...(current?.retirePending || [])];
  // A replaced failed compile still owns a durable manual-AI run; keep it
  // queued for retirement rather than silently orphaning it.
  if (current?.pending) retirePending.push(current.pending.manualAiRunId);
  return finalize({
    approved: current?.approved || null,
    pending: normalizePending({
      ...receipt,
      startedAt: safeTime(now),
      filePaths: paths,
      fileNames,
    }),
    retirePending,
  });
}

export function resumeJobBoardCareerOverride(boardData) {
  const current = recordOf(boardData);
  const pending = current?.pending;
  if (!pending || !['compiling', 'failed'].includes(pending.status)) return null;
  const { error: _error, failedAt: _failedAt, ...rest } = pending;
  const record = finalize({ ...current, pending: { ...rest, status: 'compiling' } });
  return {
    record,
    manualAiRunId: pending.manualAiRunId,
    filePaths: [...pending.filePaths],
    fileNames: [...pending.fileNames],
  };
}

function matchingPending(current, manualAiRunId) {
  const pending = current?.pending;
  return pending && isJobBoardCareerOverrideRunId(manualAiRunId) && pending.manualAiRunId === manualAiRunId
    ? pending
    : null;
}

export function approveJobBoardCareerOverride(boardData, {
  careerSnapshotId,
  profileFingerprint = null,
  manualAiRunId,
  now = Date.now(),
} = {}) {
  const current = recordOf(boardData);
  // Only the exact live run may approve: a superseded completion is stale.
  const pending = matchingPending(current, manualAiRunId);
  if (!pending) return null;
  const approvedReceipt = approveCareerImportCompilation(pending, {
    generation: pending.generation,
    attemptId: pending.attemptId,
    careerSnapshotId,
    profileFingerprint,
  });
  if (!approvedReceipt || !snapshotId(approvedReceipt.careerSnapshotId)) return null;
  return finalize({
    approved: {
      careerSnapshotId: approvedReceipt.careerSnapshotId,
      generation: pending.generation,
      fileNames: [...pending.fileNames],
      approvedAt: safeTime(now),
      profileFingerprint: typeof profileFingerprint === 'string' && profileFingerprint.trim()
        ? profileFingerprint.trim()
        : null,
    },
    pending: null,
    retirePending: current.retirePending,
  });
}

export function failJobBoardCareerOverride(boardData, { manualAiRunId, error } = {}) {
  const current = recordOf(boardData);
  const pending = matchingPending(current, manualAiRunId);
  if (!pending) return null;
  const failed = failCareerImportCompilation(pending, {
    generation: pending.generation,
    attemptId: pending.attemptId,
    error,
  });
  if (!failed) return null;
  return finalize({ ...current, pending: normalizePending(failed) });
}

export function discardJobBoardCareerOverridePending(boardData) {
  const current = recordOf(boardData);
  if (!current?.pending) return current;
  return finalize({
    approved: current.approved,
    pending: null,
    retirePending: [...current.retirePending, current.pending.manualAiRunId],
  });
}

export function clearJobBoardCareerOverride(boardData) {
  const current = recordOf(boardData);
  // A compile that may still be live cannot be cleared out from under it.
  if (!current || current.pending?.status === 'compiling') return current;
  return finalize({
    approved: null,
    pending: null,
    retirePending: [
      ...current.retirePending,
      ...(current.pending ? [current.pending.manualAiRunId] : []),
    ],
  });
}

export function markJobBoardCareerOverrideRunsRetired(boardData, runIds) {
  const current = recordOf(boardData);
  if (!current) return null;
  const retired = new Set(Array.isArray(runIds) ? runIds : []);
  return finalize({
    ...current,
    retirePending: current.retirePending.filter(id => !retired.has(id)),
  });
}

// Queue a run whose durable handoff could not be retired yet; it is retried
// later. Only override run ids are accepted (never Board combine runs).
export function queueJobBoardCareerOverrideRetire(boardData, runId) {
  const current = recordOf(boardData);
  if (!isJobBoardCareerOverrideRunId(runId)) return current;
  if (!current) return finalize({ retirePending: [runId] });
  if (current.retirePending.includes(runId)) return current;
  return finalize({ ...current, retirePending: [...current.retirePending, runId] });
}

export function jobBoardCareerOverrideRunIds(boardData) {
  const current = recordOf(boardData);
  if (!current) return [];
  return [...new Set([
    ...(current.pending ? [current.pending.manualAiRunId] : []),
    ...current.retirePending,
  ])];
}

export function hasActiveJobBoardCareerOverrideRun(boardData) {
  const current = recordOf(boardData);
  return !!current && (!!current.pending || current.retirePending.length > 0);
}

export function resolveApplicationCareerSnapshotId({ cardData, boardData } = {}) {
  const override = approvedJobBoardCareerOverrideSnapshotId(boardData);
  if (override) return { careerSnapshotId: override, source: 'board-override' };
  const raw = cardData && typeof cardData === 'object' ? cardData.careerSnapshotId : null;
  const card = typeof raw === 'string' ? snapshotId(raw.trim()) : null;
  if (card) return { careerSnapshotId: card, source: 'card' };
  return { careerSnapshotId: null, source: null };
}

// Verdict for a canvas document node dragged onto a Board: may its career
// files become the Board's career data for applications right now? Mirrors
// the panel's own import gates. The drag lane has no local run id, so a live
// compile and an interrupted one look the same here; one label covers both.
export function jobBoardCareerDropVerdict(boardData) {
  const locked = !!boardData?.locked;
  if (locked) return { kind: 'reject', label: 'Locked' };
  const { state } = jobBoardCareerOverrideView(boardData, { locked });
  if (state === 'compiling' || state === 'interrupted') {
    return { kind: 'reject', label: 'Finish current career data first' };
  }
  if (state === 'failed') return { kind: 'reject', label: 'Retry or discard first' };
  return { kind: 'accept', label: 'Use for applications' };
}

export function jobBoardCareerOverrideView(boardData, { localRunId = null, locked = false } = {}) {
  const current = recordOf(boardData);
  const pending = current?.pending || null;
  const approved = current?.approved || null;
  let state = 'empty';
  if (pending?.status === 'compiling') {
    state = localRunId && pending.manualAiRunId === localRunId ? 'compiling' : 'interrupted';
  } else if (pending?.status === 'failed') {
    state = 'failed';
  } else if (approved) {
    state = 'approved';
  }
  const recoverable = state === 'interrupted' || state === 'failed';
  return {
    state,
    approved: approved
      ? { fileNames: [...approved.fileNames], approvedAt: approved.approvedAt, careerSnapshotId: approved.careerSnapshotId }
      : null,
    pending: pending
      ? { fileNames: [...pending.fileNames], manualAiRunId: pending.manualAiRunId, error: pending.error ?? null }
      : null,
    canImport: !locked && state !== 'compiling',
    canClear: !locked && !!(approved || pending) && state !== 'compiling',
    canResume: !locked && recoverable,
    canDiscard: !locked && recoverable,
    retirePendingCount: current?.retirePending.length ?? 0,
  };
}
