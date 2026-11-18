const QUALITY_DECISIONS = new Set(['drafted', 'changed_materially', 'kept_diminishing_returns']);

export function isApplicationQualityDecision(value) {
  return QUALITY_DECISIONS.has(value);
}

export function expectedApplicationQualityDecision({ priorHash = '', currentHash = '' } = {}) {
  if (!priorHash) return 'drafted';
  return priorHash === currentHash ? 'kept_diminishing_returns' : 'changed_materially';
}

export function applicationConvergenceInstruction({ revisionAttempt = 1, unchangedSignal = 'return the current document byte-for-byte unchanged' } = {}) {
  return `Measured revision ${revisionAttempt}. There is no fixed revision limit.${revisionAttempt > 1 ? ' A prior revision remained unsatisfied; make a material correction rather than a cosmetic paraphrase.' : ''} If no material correction remains without weakening stronger job-specific evidence, ${unchangedSignal} as the diminishing-returns signal.`;
}
