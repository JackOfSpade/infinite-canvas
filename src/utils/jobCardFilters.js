// The board's card filter: a single source pill, a min-score slider, and one
// review-bucket switch. Job cards are deliberately disposable (anti-CRM) —
// there is no status field to filter on, so the filter contract is exactly
// these knobs.
//
// The review bucket exists because the slider compares a single number, and
// two kinds of card carry a number that does not mean "assessed and found
// low":
//   - an UNSCORED placeholder: the AI never returned a usable score, so the
//     scorer stored a fixed sentinel (50) with scoreStatus 'unscored…';
//   - a CAPPED card: the deterministic evidence-gap rule lowered the model's
//     own score (rawScore) to the displayed matchScore, and the cap crossed
//     the slider's threshold — the model said "apply", the rule said "don't".
// Hiding either at a 70 slider would make a scoring failure or a
// classification error look like a confident rejection. They stay visible
// (with a card badge) unless the board explicitly switches review cards off.

// Mirrors UNSCORED_SCORE_STATUS in electron/ipc/jobBatchReconcile.js. The
// scorer may stamp a more specific variant ('unscored-evidence-incomplete'),
// so detection is a prefix test on the structural field — never on the
// sentinel number, which an honestly assessed job can also score.
export const UNSCORED_SCORE_STATUS = 'unscored';

// What a placeholder looked like BEFORE scoreStatus existed: the scorer's
// fixed fallback number plus one of its two fixed explanations, and no audit.
// Only the load-time migration (serializationUtils.js) reads these, to stamp
// scoreStatus onto cards saved by an older build; live detection never does.
// A test pins both values to the scorer's exports (jobs.js /
// jobBatchReconcile.js) so the two sides cannot drift apart silently.
export const LEGACY_UNSCORED_PLACEHOLDER_SCORE = 50;
export const LEGACY_UNSCORED_PLACEHOLDER_REASONS = Object.freeze(['AI format error', 'Unable to score']);

export function isLegacyUnscoredPlaceholder(jobData = {}) {
  if (!jobData || typeof jobData !== 'object') return false;
  if (typeof jobData.scoreStatus === 'string') return false; // already stamped
  if (jobData.matchScore !== LEGACY_UNSCORED_PLACEHOLDER_SCORE) return false;
  if (jobData.fitAssessment || jobData.rawScore !== undefined) return false; // an audited, honest 50
  return LEGACY_UNSCORED_PLACEHOLDER_REASONS.includes(jobData.reasoning);
}

export function isUnscoredPlaceholderCard(jobData = {}) {
  const status = jobData?.scoreStatus;
  return typeof status === 'string' && status.startsWith(UNSCORED_SCORE_STATUS);
}

function finiteScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// True when the evidence-gap calibration moved this card from at-or-above the
// threshold to below it. A card without an audited rawScore (legacy or
// placeholder) can never be "capped".
export function isCappedAcrossThreshold(jobData = {}, scoreThreshold = 0) {
  if (isUnscoredPlaceholderCard(jobData)) return false;
  const raw = finiteScore(jobData?.rawScore);
  const shown = finiteScore(jobData?.matchScore);
  if (raw === null || shown === null) return false;
  return raw >= scoreThreshold && shown < scoreThreshold;
}

// Why a card belongs to the review bucket at this threshold: 'unscored',
// 'capped', or null when it is an ordinary scored card.
export function jobCardReviewReason(jobData = {}, scoreThreshold = 0) {
  if (isUnscoredPlaceholderCard(jobData)) return 'unscored';
  if (isCappedAcrossThreshold(jobData, scoreThreshold)) return 'capped';
  return null;
}

export function isJobCardVisible(jobData = {}, {
  sourceFilter = null,
  scoreThreshold = 0,
  showReviewCards = true,
} = {}) {
  const sourceOk = !sourceFilter || jobData.source === sourceFilter;
  if (!sourceOk) return false;
  const scoreOk = (jobData.matchScore ?? 0) >= scoreThreshold;
  if (scoreOk) return true;
  return showReviewCards && jobCardReviewReason(jobData, scoreThreshold) !== null;
}

// Canonical { scoreThreshold, sourceFilter, showReviewCards } shape derived
// from a hub's own persisted data, mirroring isJobCardVisible's defaults.
// Every call site that feeds a hub's filter into computeJobTreeView should
// build it through here instead of reconstructing the object literal by hand.
// `showReviewCards` defaults ON: only an explicit false hides the bucket, so a
// board saved before the switch existed keeps its review cards visible.
export function hubCardFilter(hubData = {}) {
  return {
    scoreThreshold: hubData.scoreThreshold ?? 0,
    sourceFilter: hubData.sourceFilter ?? null,
    showReviewCards: hubData.showReviewCards !== false,
  };
}
