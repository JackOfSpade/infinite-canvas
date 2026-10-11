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

// The retained career input a saved compile checkpoint would re-read.  Shared by
// the resume itself and the banner that describes it, so what is explained is
// exactly what Continue would submit.
export function careerResumeInputPaths(data) {
  return [...new Set([
    ...(Array.isArray(data?.filePaths) ? data.filePaths : []),
    ...(Array.isArray(data?.careerFilePaths) ? data.careerFilePaths : []),
    data?.filePath,
  ].filter(value => typeof value === 'string' && value))];
}

// The verdict the saved-compilation banner shows.  A marker whose card has no
// retained input paths can never be inspected (there is nothing to stage), so
// it gets a terminal `missing-input` state rather than waiting on a check that
// will never run; any other marker shows the inspected verdict once it exists
// for exactly this run and these paths, and `checking` until then.
export function careerResumeBannerStatus({ markerRunId = null, paths = [], inspected = null, key = '' } = {}) {
  if (!markerRunId) return null;
  if (!Array.isArray(paths) || paths.length === 0) return { state: 'missing-input' };
  return inspected && inspected.key === key ? inspected : { state: 'checking' };
}

// Plain-language account of what Continue will really do for a saved career
// compilation, from the main process's content-level verdict
// (`inspect-career-compile-resume`).  The wording never claims an exact resume
// unless the verdict proves one; `exact` is returned so a caller/test can assert
// that no other state is ever presented as exact.
export function careerCompileResumeExplanation(status, { paused = false } = {}) {
  const lead = paused ? 'You paused this career compilation. ' : 'This career compilation was interrupted. ';
  const title = 'Saved career compilation';
  const reuse = 'Continue re-runs compilation and reuses each earlier answer whose prompt is unchanged; anything else is asked again. It does not claim to resume at an exact step.';
  switch (status?.state) {
    case 'checking':
      return { title, exact: false, body: `${lead}Checking whether it can resume exactly…` };
    case 'snapshot-ready':
      return { title, exact: false, body: `${lead}An approved snapshot already exists for the current career files, so Continue adopts it and asks nothing more.` };
    case 'exact': {
      const count = Number.isFinite(status.acceptedSteps) && status.acceptedSteps > 0 ? Math.floor(status.acceptedSteps) : 0;
      return {
        title, exact: true,
        body: count > 0
          ? `${lead}Your career files and the compiler are unchanged since it was saved. Continue replays the ${count} answer${count === 1 ? '' : 's'} you already gave for them, in order, and stops at the first one still needed.`
          : `${lead}Your career files and the compiler are unchanged since it was saved, but no answer was accepted for these exact files yet, so Continue starts with the first question.`,
      };
    }
    case 'missing-input':
      return {
        title, exact: false,
        body: `${lead}This card no longer records the career files it was compiling, so it cannot be resumed. Use Clear career data before choosing new input.`,
      };
    case 'restart':
      return {
        title, exact: false,
        body: status.reason === 'run-missing'
          ? `${lead}Its saved answers are no longer on disk, so Continue will restart compilation from the beginning.`
          : `${lead}Your career files or the compiler changed after it was saved, so the earlier answers no longer apply. Continue will restart compilation from the beginning.`,
      };
    case 'unverified':
      return { title, exact: false, body: `${lead}It was saved before change tracking existed, so an exact resume cannot be verified. ${reuse}` };
    default:
      return { title, exact: false, body: `${lead}It could not be checked just now. ${reuse}` };
  }
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
