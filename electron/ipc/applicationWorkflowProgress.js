// Metadata derived only from the host's frozen workflow, never model output.
export function applicationWorkflowProgress(input, state) {
  const work = state?.writeVerify;
  const candidateCount = work?.count ?? input?.candidateCount;
  const startedAt = Date.parse(input?.createdAt);
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 1 || candidateCount > 64) return null;
  const candidates = Array.isArray(work?.candidates) ? work.candidates : [];
  const ready = candidates.filter(row => row.status === 'accepted').length;
  const rejected = candidates.filter(row => row.status === 'dropped').length;
  let candidate = null;
  if (['write', 'convert', 'verify-correction', 'fit-correction'].includes(state?.stage)
    && Number.isSafeInteger(work?.ordinal) && work.ordinal >= 0 && work.ordinal < candidateCount) candidate = work.ordinal + 1;
  if (['fact-check', 'fact-correction', 'fact-recheck'].includes(state?.stage)) {
    const index = candidates.findIndex(row => row.id === work?.ranking?.[work?.factIndex]);
    if (index >= 0) candidate = index + 1;
  }
  return { workflow: 'write-verify', startedAt: Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : null,
    candidate, candidateCount, checked: ready + rejected, ready, rejected };
}
