import { hasStoredPreferenceVerdicts, splitKeptScores } from '../../utils/jobSearchPreferenceReevaluation.js';
import { jobBoardOverrideJobKey, jobBoardOverrideListings } from '../../utils/jobBoardPreferenceOverride.js';

const SCORE_FIELDS = ['matchScore', 'reasoning', 'careerDirection', 'requirementAssessments', 'materialGaps', 'strengths', 'experienceAssessment',
  'confidence', 'fitAssessment', 'rawScore', 'adjustedScore', 'adjustments', 'calibration', 'scoreStatus'];
const listingOnly = (job) => {
  const listing = { ...job };
  for (const field of SCORE_FIELDS) delete listing[field];
  return listing;
};
const isUnscored = job => typeof job?.scoreStatus === 'string' && job.scoreStatus.startsWith('unscored');

/**
 * Puts a Board's override rules over its Searches' saved listings: asks only the
 * rule checks it has no answer for, scores only passing jobs with no current
 * score, and returns the rows Combine merges. Each step is saved before the next,
 * so an interrupted Combine resumes without asking again. Search data is only read.
 */
export async function runBoardPreferenceOverrideStage(modules, {
  override, nodeId, manualAiRunId, cancelled = () => false, onProgress = () => {}, persist = () => {},
  interpret, reapply, evaluate, score,
}) {
  let record = override;
  const save = (patch) => { record = { ...record, ...patch }; persist(record); };
  if (!record.plan) {
    const sameBrief = modules.find(module => module.searchBriefPlan && String(module.jobPreferences || '').trim() === record.brief);
    let plan = sameBrief?.searchBriefPlan || null;
    if (!plan) {
      onProgress({ label: 'Reading your Board preferences' });
      const result = await interpret({ jobPreferences: record.brief, careerSnapshotId: modules[0]?.careerSnapshotId || null, nodeId, manualAiRunId });
      if (cancelled()) return { cancelled: true };
      if (result?.success === false) throw Object.assign(new Error(result.error || 'Failed to understand the Board preferences.'), { code: result.errorCode });
      plan = result?.preferencePlan || result?.jobPreferencePlan || null;
      if (!plan) throw new Error('The Board preferences produced no rules.');
    }
    // Titles only steer a scan, and the override never changes what a Search scans.
    save({ plan: { ...plan, titles: [] } });
  }
  // checked, passed and removed count distinct jobs: one listing shared by two Searches is one job, and passes if
  // any Search's copy passes. The *Rows counts are per Search, which is what balances against the merge's incoming rows.
  const checkedKeys = new Set();
  const passedKeys = new Set();
  const totals = { checked: 0, passed: 0, removed: 0, checkedRows: 0, removedRows: 0, newlyScored: 0, keptScores: 0, reused: 0, unscored: 0 };
  const jobArrays = [];
  // Rule answers read only the listing, and a score only the listing and career
  // record, so one job shared by two Searches is asked once.
  const sharedAnswers = new Map();
  for (const result of Object.values(record.results || {})) {
    for (const [key, assessment] of Object.entries(result?.assessments || {})) sharedAnswers.set(key, assessment);
  }
  const scoresOnRecord = new Map();
  const knownScores = careerSnapshotId => {
    if (!scoresOnRecord.has(careerSnapshotId)) scoresOnRecord.set(careerSnapshotId, []);
    return scoresOnRecord.get(careerSnapshotId);
  };
  for (const module of modules) {
    knownScores(module.careerSnapshotId).push(...(module.scoredJobs || []));
    const prior = record.results?.[module.id];
    if (prior?.careerSnapshotId === module.careerSnapshotId) knownScores(module.careerSnapshotId).push(...Object.values(prior.scored || {}));
  }
  for (const module of modules) {
    const listings = jobBoardOverrideListings(module);
    const prior = record.results?.[module.id];
    const sameRecord = prior?.careerSnapshotId === module.careerSnapshotId;
    const assessments = { ...(prior?.assessments || {}) };
    for (const job of listings) {
      const key = jobBoardOverrideJobKey(job);
      if (!assessments[key] && sharedAnswers.has(key)) assessments[key] = sharedAnswers.get(key);
    }
    const scored = sameRecord ? { ...(prior?.scored || {}) } : {};
    const unanswered = listings.filter(job => !assessments[jobBoardOverrideJobKey(job)]);
    const stored = unanswered.filter(job => hasStoredPreferenceVerdicts([job], record.plan));
    const toAsk = unanswered.filter(job => !stored.includes(job));
    const collect = (rows) => {
      for (const row of rows) {
        assessments[jobBoardOverrideJobKey(row)] = row.preferenceAssessment;
        sharedAnswers.set(jobBoardOverrideJobKey(row), row.preferenceAssessment);
      }
    };
    if (stored.length) {
      const result = await reapply({ jobs: stored.map(listingOnly), preferencePlan: record.plan });
      if (result?.success === false) throw new Error(result.error || 'Failed to re-apply the saved preference results.');
      collect(result.candidatePool);
      totals.reused += stored.length;
    }
    if (cancelled()) return { cancelled: true };
    if (toAsk.length) {
      onProgress({ label: `Checking ${toAsk.length} saved job(s) against your Board preferences` });
      const result = await evaluate({ jobs: toAsk.map((job) => { const { preferenceAssessment: _old, ...row } = listingOnly(job); return row; }),
        jobPreferences: record.brief, preferencePlan: record.plan, jobPreferencePlan: record.plan, careerSnapshotId: module.careerSnapshotId, nodeId, manualAiRunId });
      if (cancelled()) return { cancelled: true };
      if (!result?.success) throw Object.assign(new Error(result?.error || 'Failed to check saved jobs against the Board preferences.'), { code: result?.errorCode });
      collect(result.candidatePool);
    }
    const unchecked = listings.filter(job => !assessments[jobBoardOverrideJobKey(job)]);
    if (unchecked.length) throw new Error(`${unchecked.length} saved job(s) came back without a preference result.`);
    const results = () => ({ ...record.results, [module.id]: { careerSnapshotId: module.careerSnapshotId, assessments, scored } });
    save({ results: results() });
    const passed = listings.filter(job => assessments[jobBoardOverrideJobKey(job)]?.status !== 'filtered')
      .map(job => ({ ...job, preferenceAssessment: assessments[jobBoardOverrideJobKey(job)] }));
    const { jobsToScore, keptScoredJobs } = splitKeptScores(passed, knownScores(module.careerSnapshotId), module.careerSnapshotId);
    const newlyScored = [];
    if (jobsToScore.length) {
      onProgress({ label: `Scoring ${jobsToScore.length} newly passing job(s)` });
      const result = await score({ jobs: jobsToScore.map(listingOnly), careerSnapshotId: module.careerSnapshotId, nodeId, manualAiRunId });
      if (cancelled()) return { cancelled: true };
      if (!result?.success || !Array.isArray(result.scoredJobs)) throw Object.assign(new Error(result?.error || 'Failed to score the newly passing jobs.'), { code: result?.errorCode });
      for (const row of result.scoredJobs) {
        const stamped = { ...row, careerSnapshotId: module.careerSnapshotId };
        newlyScored.push(stamped);
        // A failed score is shown as unavailable and asked again by the next Combine.
        if (!isUnscored(row)) { scored[jobBoardOverrideJobKey(row)] = stamped; knownScores(module.careerSnapshotId).push(stamped); }
        else totals.unscored += 1;
      }
      save({ results: results() });
    }
    for (const listing of listings) checkedKeys.add(jobBoardOverrideJobKey(listing));
    for (const listing of passed) passedKeys.add(jobBoardOverrideJobKey(listing));
    totals.checkedRows += listings.length;
    totals.removedRows += listings.length - passed.length;
    totals.newlyScored += newlyScored.length;
    totals.keptScores += keptScoredJobs.length;
    jobArrays.push([...newlyScored, ...keptScoredJobs].map(job => ({ ...job, originHubId: job.originHubId || module.id })));
  }
  totals.checked = checkedKeys.size;
  totals.passed = passedKeys.size;
  totals.removed = checkedKeys.size - passedKeys.size;
  save({ counts: totals });
  return { jobArrays, override: record, counts: totals };
}
