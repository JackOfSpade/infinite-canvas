// Pure model of a Board's post-scrape preferences. The Search keeps its own brief
// and results untouched; the override replaces their rules for this Board until
// cleared, and later scans are checked against it at Combine.
import { dedupJobsAcrossSources, sourceJobKey } from './jobIdentity.js';

export const JOB_BOARD_PREFERENCE_OVERRIDE_VERSION = 1;
export const JOB_BOARD_PREFERENCE_BRIEF_MAX_LENGTH = 4000;

const cleanBrief = value => (typeof value === 'string' ? value.trim().slice(0, JOB_BOARD_PREFERENCE_BRIEF_MAX_LENGTH) : '');

export function activeJobBoardPreferenceOverride(data) {
  const record = data?.jobBoardPreferenceOverride;
  return record?.version === JOB_BOARD_PREFERENCE_OVERRIDE_VERSION && cleanBrief(record.brief) ? record : null;
}

/** A score does not read preferences, so an edit keeps scores and re-asks only the rule checks. */
export function applyJobBoardPreferenceBrief(data, brief, { now = Date.now() } = {}) {
  const nextBrief = cleanBrief(brief);
  if (!nextBrief) return null;
  const prior = activeJobBoardPreferenceOverride(data);
  if (prior && cleanBrief(prior.brief) === nextBrief) return { ...prior, appliedAt: now, combinedAt: null };
  const results = Object.fromEntries(Object.entries(prior?.results || {}).map(([hubId, result]) => [hubId, { careerSnapshotId: result?.careerSnapshotId || null, assessments: {}, scored: result?.scored || {} }]));
  return { version: JOB_BOARD_PREFERENCE_OVERRIDE_VERSION, brief: nextBrief, plan: null, appliedAt: now, combinedAt: null, counts: null, results };
}

/** What the box's "Use Job Search preferences" button offers, and whether the searches disagree. */
export function jobBoardPreferenceSeed(modules) {
  const briefs = [...new Set((Array.isArray(modules) ? modules : []).map(module => cleanBrief(module?.jobPreferences)).filter(Boolean))];
  return { brief: briefs[0] || '', briefsDiffer: briefs.length > 1 };
}

/** Every saved listing a Search holds, including those its own rules filtered out. */
export function jobBoardOverrideListings(module) {
  const pool = Array.isArray(module?.preferenceCandidatePool) ? module.preferenceCandidatePool.filter(Boolean) : [];
  const scored = Array.isArray(module?.scoredJobs) ? module.scoredJobs.filter(Boolean) : [];
  return dedupJobsAcrossSources([...pool, ...scored]);
}

export const jobBoardOverrideJobKey = job => String(sourceJobKey(job) || '');

export function jobBoardPreferenceOverrideView(data) {
  const record = activeJobBoardPreferenceOverride(data);
  if (!record) return { state: 'empty', brief: '', counts: null };
  return { state: record.combinedAt ? 'applied' : 'pending', brief: record.brief, counts: record.counts || null, combinedAt: record.combinedAt || null };
}
