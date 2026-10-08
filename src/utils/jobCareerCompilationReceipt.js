// A career-file import has two deliberately separate phases.  The compiler
// owns source paths and may publish an approved immutable snapshot; providers
// only receive the opaque snapshot id.  Keeping this receipt on the hub makes
// that boundary survive a render, a Board queue turn, or a manual-AI pause.

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function snapshotId(value) {
  const id = text(value);
  return id && /^[a-f0-9]{64}$/u.test(id) ? id : null;
}

function nowAttemptId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function beginCareerImportCompilation({ generation, manualAiRunId = null, attemptId = nowAttemptId() } = {}) {
  const normalizedGeneration = text(generation);
  const normalizedAttemptId = text(attemptId);
  if (!normalizedGeneration || !normalizedAttemptId) return null;
  return {
    version: 1,
    generation: normalizedGeneration,
    attemptId: normalizedAttemptId,
    status: 'compiling',
    ...(text(manualAiRunId) ? { manualAiRunId: text(manualAiRunId) } : {}),
    startedAt: Date.now(),
  };
}

export function careerImportCompilationMatches(receipt, { generation, attemptId } = {}) {
  return receipt?.version === 1
    && text(receipt.generation) === text(generation)
    && text(receipt.attemptId) === text(attemptId);
}

export function approveCareerImportCompilation(receipt, {
  generation,
  attemptId,
  careerSnapshotId,
  profileFingerprint = null,
} = {}) {
  if (!careerImportCompilationMatches(receipt, { generation, attemptId })) return null;
  const canonicalSnapshotId = snapshotId(careerSnapshotId);
  if (!canonicalSnapshotId) return null;
  return {
    ...receipt,
    status: 'approved',
    careerSnapshotId: canonicalSnapshotId,
    ...(text(profileFingerprint) ? { profileFingerprint: text(profileFingerprint) } : {}),
    approvedAt: Date.now(),
    error: undefined,
  };
}

export function failCareerImportCompilation(receipt, { generation, attemptId, error } = {}) {
  if (!careerImportCompilationMatches(receipt, { generation, attemptId })) return null;
  return {
    ...receipt,
    status: 'failed',
    error: String(error || 'Failed to compile career files').slice(0, 1000),
    failedAt: Date.now(),
  };
}

export function approvedCareerImportCompilation(data, { generation } = {}) {
  const receipt = data?.careerImportCompilation;
  return receipt?.version === 1
    && receipt.status === 'approved'
    && text(receipt.generation) === text(generation)
    && !!snapshotId(receipt.careerSnapshotId)
    ? receipt
    : null;
}

// Renderer-held profile fields and retained file paths are never admission
// authority.  The only UI-level proof available after the main process has
// atomically published and re-read a snapshot is this exact approved receipt
// bound to the live generation and canonical snapshot id.
export function currentApprovedCareerImportSnapshot(data, { generation } = {}) {
  const approved = approvedCareerImportCompilation(data, { generation });
  const id = snapshotId(approved?.careerSnapshotId);
  return approved && id && snapshotId(data?.careerSnapshotId) === id
    ? approved
    : null;
}

export function careerImportCompilationAdmission(data, { generation } = {}) {
  const receipt = data?.careerImportCompilation;
  if (!receipt || text(receipt.generation) !== text(generation)) return { kind: 'missing' };
  if (receipt.status === 'compiling') return { kind: 'compiling', receipt };
  if (receipt.status === 'failed') return { kind: 'failed', receipt };
  const approved = currentApprovedCareerImportSnapshot(data, { generation });
  return approved ? { kind: 'approved', receipt: approved } : { kind: 'missing' };
}

// A paused compiler handoff is not a paused provider search.  In particular it
// has no job-run manifest or frozen search window to prove: its authority is
// the current import generation's compiler receipt plus the exact manual-AI
// run that receipt started.  Keep this small proof separate from provider
// recovery so callers cannot accidentally turn a career-import retry into a
// job-search restart.
export function resumableCareerImportCompilation(data, {
  generation = data?.careerImportGeneration,
  manualAiRunId,
} = {}) {
  const normalizedGeneration = text(generation);
  const normalizedManualAiRunId = text(manualAiRunId);
  const receipt = data?.careerImportCompilation;
  if (
    !normalizedGeneration
    || !normalizedManualAiRunId
    || receipt?.version !== 1
    || !['compiling', 'failed'].includes(receipt.status)
    || text(receipt.generation) !== normalizedGeneration
    || text(receipt.manualAiRunId) !== normalizedManualAiRunId
  ) return null;
  return receipt;
}

// Tiny orchestration seam used by every legacy path alias: provider admission
// receives the compiler's immutable output, never the original file paths.
export async function compileBeforeCareerProvider({ compile, provider } = {}) {
  if (typeof compile !== 'function' || typeof provider !== 'function') {
    throw new Error('Career compilation and provider callbacks are required.');
  }
  const compiled = await compile();
  if (compiled?.status !== 'compiled') return compiled;
  return provider({
    profile: compiled.profile,
    careerSnapshotId: compiled.careerSnapshotId,
    fingerprint: compiled.fingerprint,
  });
}
