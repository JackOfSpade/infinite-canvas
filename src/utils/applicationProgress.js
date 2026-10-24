// Presentation of host-reported application progress. A stage is a current
// activity, not evidence that every earlier activity or candidate finished.
const STAGE_LABELS = Object.freeze({
  requirements: 'Read job requirements',
  'requirements-audit': 'Audit job requirements',
  'requirements-adjudication': 'Resolve requirement disagreements',
  'evidence-plan': 'Plan supporting evidence',
  'editorial-plan': 'Plan application',
  'host-verification': 'Check response',
  resume: 'Write résumé',
  'cover-letter': 'Write cover letter',
  review: 'Review and edit',
  'requirement-disposition': 'Check requirement coverage',
  'blind-review': 'Independent review',
  'blind-repair-context': 'Prepare review corrections',
  'refinement-judge': 'Compare revisions',
  write: 'Write application',
  convert: 'Structure application',
  'verify-correction': 'Correct verification findings',
  'fit-correction': 'Fit documents to one page',
  pick: 'Compare candidates',
  'fact-check': 'Fact-check selected candidate',
  'fact-correction': 'Correct fact-check findings',
  'fact-recheck': 'Recheck corrected facts',
  'write-verify-human-stop': 'Application needs review',
});

export function applicationProgressStageLabel(stage) {
  return typeof stage === 'string' && Object.hasOwn(STAGE_LABELS, stage) ? STAGE_LABELS[stage] : null;
}

const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

export function normalizeApplicationProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.workflow !== 'write-verify') return null;
  const candidateCount = integer(value.candidateCount, 100);
  if (!candidateCount) return null;
  const candidate = integer(value.candidate, candidateCount);
  return {
    workflow: 'write-verify',
    startedAt: Number.isFinite(value.startedAt) && value.startedAt >= 0 ? value.startedAt : null,
    candidate: candidate && candidate >= 1 ? candidate : null,
    candidateCount,
    checked: integer(value.checked, candidateCount),
    ready: integer(value.ready, candidateCount),
    rejected: integer(value.rejected, candidateCount),
  };
}

export function applicationProgressContext(value) {
  const progress = normalizeApplicationProgress(value);
  if (!progress) return { label: 'Application generation', summary: '', startedAt: null };
  const counts = [];
  if (progress.checked !== null) counts.push(`${progress.checked} of ${progress.candidateCount} checked`);
  if (progress.ready !== null) counts.push(`${progress.ready} passed initial checks`);
  if (progress.rejected !== null) counts.push(`${progress.rejected} rejected in initial checks`);
  return {
    label: progress.candidate === null
      ? `Application candidates · ${progress.candidateCount} planned`
      : `Application candidates · Candidate ${progress.candidate} of ${progress.candidateCount}`,
    summary: counts.join(' · '),
    startedAt: progress.startedAt,
  };
}
