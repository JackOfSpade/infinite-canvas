// Persisted v2 manifests include the validator stamp that the retired blind-review
// policy produced. Keep its value stable so removing that legacy stage does not
// misclassify intact in-flight v2 jobs as written by a different build.
const RETIRED_BLIND_REVIEW_VALIDATOR_STAMP = 'be9daa51b6a00720cf7bf900637763cf85ee33e582ff54a96eda4786029ecfa1';

export function applicationBlindReviewValidatorStamp() { return RETIRED_BLIND_REVIEW_VALIDATOR_STAMP; }
export function isApplicationBlindReviewValidatorStamp(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value); }
