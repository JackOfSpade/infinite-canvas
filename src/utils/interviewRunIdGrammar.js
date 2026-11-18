// The one grammar for an Interview Helper manual-AI run id, and the cap on its
// node-deletion retirement receipts. Persisted canvas data is validated against
// these before it reaches main-process cleanup, so they must never widen.
export const INTERVIEW_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
export const MAX_RETIREMENT_RECEIPTS = 32;
