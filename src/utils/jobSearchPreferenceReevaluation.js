// Pure helpers for re-checking a completed Search's saved jobs against its
// preferences. A fit score reads the career record and the listing, never the
// preferences, so a score stays valid for as long as its career snapshot does.
import { jobTitleCompanyLocationKey, sourceJobKey } from './jobIdentity.js';

const isKeptScore = (job, careerSnapshotId) => typeof job?.matchScore === 'number'
  && Number.isFinite(job.matchScore)
  && !(typeof job.scoreStatus === 'string' && job.scoreStatus.startsWith('unscored'))
  && job.careerSnapshotId === careerSnapshotId;

const planRules = plan => [
  ...(Array.isArray(plan?.softPreferences) ? plan.softPreferences.map(item => ({ ...item, strict: false })) : []),
  ...(Array.isArray(plan?.strictRequirements) ? plan.strictRequirements.map(item => ({ ...item, strict: true })) : []),
];

/**
 * True when every saved job holds rule-by-rule results for exactly this plan, so
 * no AI has to read it again. A paused edit can commit a new plan beside results
 * for the old one, so the rules themselves are compared, not just the brief.
 */
export function hasStoredPreferenceVerdicts(jobs, plan) {
  const rules = planRules(plan);
  if (!Array.isArray(jobs) || jobs.length === 0 || rules.length === 0) return false;
  const strictRuleIds = new Set(rules.filter(rule => rule.strict).map(rule => rule.id));
  return jobs.every((job) => {
    const matches = job?.preferenceAssessment?.matches;
    if (!Array.isArray(matches)) return false;
    const byId = new Map(matches.map(match => [match?.preferenceId, match]));
    return rules.every(rule => byId.get(rule.id)?.criterion === rule.criterion && !!byId.get(rule.id)?.strict === rule.strict)
      && matches.every(match => !match?.strict || strictRuleIds.has(match.preferenceId));
  });
}

/**
 * Splits the jobs that passed into those a current score already covers and
 * those that still need scoring. A kept job takes its fresh preference result.
 */
export function splitKeptScores(passedJobs, existingScoredJobs, careerSnapshotId) {
  const scored = new Map();
  for (const job of Array.isArray(existingScoredJobs) ? existingScoredJobs : []) {
    if (!isKeptScore(job, careerSnapshotId)) continue;
    for (const key of [sourceJobKey(job), jobTitleCompanyLocationKey(job)]) {
      if (key && !scored.has(key)) scored.set(key, job);
    }
  }
  const jobsToScore = [];
  const keptScoredJobs = [];
  for (const job of Array.isArray(passedJobs) ? passedJobs : []) {
    const kept = scored.get(sourceJobKey(job)) || scored.get(jobTitleCompanyLocationKey(job));
    if (kept) keptScoredJobs.push({ ...kept, preferenceAssessment: job.preferenceAssessment });
    else jobsToScore.push(job);
  }
  return { jobsToScore, keptScoredJobs };
}

/** The scorer's order: fit first, then soft preferences as the tie-breaker. */
export function mergeScoredJobs(newlyScoredJobs, keptScoredJobs) {
  return [...(Array.isArray(newlyScoredJobs) ? newlyScoredJobs : []), ...(Array.isArray(keptScoredJobs) ? keptScoredJobs : [])].sort((a, b) => (
    b.matchScore - a.matchScore
    || (Number(b.preferenceAssessment?.preferenceScore) || 0) - (Number(a.preferenceAssessment?.preferenceScore) || 0)
    || (Number(a.preferenceAssessment?.conflictingSoftPreferences) || 0) - (Number(b.preferenceAssessment?.conflictingSoftPreferences) || 0)
  ));
}
