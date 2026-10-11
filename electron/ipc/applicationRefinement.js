/** Pure policy for the v8 blind-review panel and optional judged refinement. */
import { APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE, authorityDigest } from './applicationAuthorityWorkflow.js';

export { APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE } from './applicationAuthorityWorkflow.js';
export const APPLICATION_REFINEMENT_VERSION = 1;
export const APPLICATION_REFINEMENT_JUDGE_COUNT = 2;
export const APPLICATION_REFINEMENT_ROUND_CAP = 2;
export const APPLICATION_REFINEMENT_MIN_MAJOR_FINDINGS = 1;
export const APPLICATION_REFINEMENT_KINDS = Object.freeze(['truth', 'editorial']);
export const APPLICATION_REFINEMENT_SEVERITIES = Object.freeze(['major', 'minor']);

/** Historical plans retain their all-blocking meaning. Fact scopes cannot be demoted. */
export function applicationBlindReviewFindingKind(promptMode, track, finding = {}) {
  if (promptMode !== APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE || track === 'fact-fidelity') return 'truth';
  return finding?.kind === 'truth' ? 'truth' : 'editorial';
}

/** A judge's positions are deterministic, opposite, and bound to the document pair. */
export function refinementCandidatePosition({ candidateDigest, incumbentDigest, round, judgeIndex }) {
  if (!/^[a-f0-9]{64}$/u.test(candidateDigest) || !/^[a-f0-9]{64}$/u.test(incumbentDigest)
    || !Number.isSafeInteger(round) || round < 1 || ![0, 1].includes(judgeIndex)) {
    throw new Error('Refinement assignment needs two document digests, a positive round and judge index 0 or 1.');
  }
  const seed = authorityDigest({ candidateDigest, incumbentDigest, round });
  const firstIsA = Number.parseInt(seed.slice(-1), 16) % 2 === 0;
  return (firstIsA === (judgeIndex === 0)) ? 'A' : 'B';
}

/** Any disagreement, unsupported-claim flag or malformed judgment keeps the incumbent. */
export function selectRefinementWinner(judgments) {
  if (!Array.isArray(judgments) || judgments.length !== APPLICATION_REFINEMENT_JUDGE_COUNT) return 'incumbent';
  const positions = new Set();
  let prefersCandidate = false;
  for (const judgment of judgments) {
    if (!judgment || !['A', 'B'].includes(judgment.candidatePosition)
      || !['A', 'B', 'tie'].includes(judgment.verdict)
      || judgment.candidateUnsupportedClaim !== false) return 'incumbent';
    positions.add(judgment.candidatePosition);
    if (judgment.verdict === 'tie') continue;
    if (judgment.verdict !== judgment.candidatePosition) return 'incumbent';
    prefersCandidate = true;
  }
  return positions.size === 2 && prefersCandidate ? 'candidate' : 'incumbent';
}

/** Records are self-verifying; callers also bind their digests into the store chain. */
export function signedRefinementRecord(kind, fields) {
  if (!['incumbent', 'candidate', 'judgment', 'outcome', 'rejected'].includes(kind)
    || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Invalid refinement record.');
  }
  const unsigned = { version: APPLICATION_REFINEMENT_VERSION, kind: `refinement-${kind}`, ...fields };
  return { ...unsigned, digest: authorityDigest(unsigned) };
}

export function assertSignedRefinementRecord(record) {
  if (!record || typeof record !== 'object' || !/^refinement-(?:incumbent|candidate|judgment|outcome|rejected)$/u.test(record.kind)) {
    throw new Error('Invalid refinement record kind.');
  }
  const { digest, ...unsigned } = record;
  if (record.version !== APPLICATION_REFINEMENT_VERSION || digest !== authorityDigest(unsigned)) {
    throw new Error('Refinement record digest is invalid.');
  }
  return record;
}
