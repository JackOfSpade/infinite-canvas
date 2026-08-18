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

// One convergence policy serves both generation routes. A document can keep
// iterating for as long as the editor returns a novel candidate. Returning the
// current document unchanged is the editor's explicit diminishing-returns
// signal; returning any earlier candidate is a convergence cycle and stops the
// loop for the same reason. Provider credit exhaustion remains a provider
// failure, not an app-authored attempt cap.
export function assessApplicationRevision({ currentHash = '', candidateHash = '', seenHashes = [] } = {}) {
  if (candidateHash === currentHash) {
    return { accept: false, diminishingReturns: true, reason: 'the revision was byte-for-byte unchanged' };
  }
  if (seenHashes instanceof Set ? seenHashes.has(candidateHash) : Array.from(seenHashes || []).includes(candidateHash)) {
    return { accept: false, diminishingReturns: true, reason: 'the revision repeated a previously measured document' };
  }
  return { accept: true, diminishingReturns: false, reason: 'the revision is a novel document candidate' };
}

export function createApplicationConvergenceTracker(initialHash = '') {
  let currentHash = initialHash;
  const seenHashes = new Set(initialHash ? [initialHash] : []);
  return {
    assess(candidateHash = '') {
      const result = assessApplicationRevision({ currentHash, candidateHash, seenHashes });
      if (result.accept) {
        currentHash = candidateHash;
        seenHashes.add(candidateHash);
      }
      return result;
    },
    get currentHash() { return currentHash; },
  };
}
