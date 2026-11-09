// Bumped whenever company research answers mean something different (v2, 2026-11-08:
// research must identify the organization that posted the job before answering, so a
// same-name company can no longer confirm a recruiter's rule). Board cards carrying an
// older version are researched again instead of being reused. Kept dependency-free so
// renderer code can import it without pulling main-process modules into its bundle.
export const COMPANY_RESEARCH_VERSION = 2;
