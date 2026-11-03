// Scoring runs for every eligible listing; every other automatic AI or web task
// after scraping is for jobs at or above the fit threshold. This module has no
// Node dependencies because the renderer's cards and Board stage read it too.
import { RESEARCH_MIN_FIT_SCORE } from './resultCaps.js';

export { RESEARCH_MIN_FIT_SCORE };

export const RESEARCH_ELIGIBILITY = Object.freeze({
  eligible: 'eligible',
  belowThreshold: 'below-threshold',
  scoreUnavailable: 'score-unavailable',
});

/** Reads the post-ceiling, post-gap-review score. A failed score's numeric fallback is not a score. */
export function classifyResearchEligibility(job) {
  if (typeof job?.scoreStatus === 'string' && job.scoreStatus.startsWith('unscored')) return RESEARCH_ELIGIBILITY.scoreUnavailable;
  if (typeof job?.matchScore !== 'number' || !Number.isFinite(job.matchScore)) return RESEARCH_ELIGIBILITY.scoreUnavailable;
  return job.matchScore >= RESEARCH_MIN_FIT_SCORE ? RESEARCH_ELIGIBILITY.eligible : RESEARCH_ELIGIBILITY.belowThreshold;
}

export const isResearchEligible = job => classifyResearchEligibility(job) === RESEARCH_ELIGIBILITY.eligible;

/** The true reason a job has no automatic research, or null for an eligible job. */
export function researchSkipReason(job) {
  const eligibility = classifyResearchEligibility(job);
  if (eligibility === RESEARCH_ELIGIBILITY.belowThreshold) return `Not researched: fit below ${RESEARCH_MIN_FIT_SCORE}`;
  if (eligibility === RESEARCH_ELIGIBILITY.scoreUnavailable) return 'Not researched: fit score unavailable';
  return null;
}

/** The strict company rules still open on a job, whether research is waiting or could not settle them. */
export function unverifiedCompanyPreferences(job) {
  const matches = job?.preferenceAssessment?.matches;
  return (Array.isArray(matches) ? matches : []).filter(match => match?.strict && match.outcome === 'unverified' && ['company', 'perk'].includes(match.category));
}

export function summarizeResearchEligibility(jobs) {
  const counts = { minFitScore: RESEARCH_MIN_FIT_SCORE, total: 0, eligible: 0, skippedBelowFit: 0, skippedUnscored: 0 };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    counts.total += 1;
    const eligibility = classifyResearchEligibility(job);
    if (eligibility === RESEARCH_ELIGIBILITY.eligible) counts.eligible += 1;
    else if (eligibility === RESEARCH_ELIGIBILITY.belowThreshold) counts.skippedBelowFit += 1;
    else counts.skippedUnscored += 1;
  }
  return counts;
}
