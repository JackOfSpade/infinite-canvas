import { isResearchEligible, RESEARCH_MIN_FIT_SCORE } from '../../../electron/ipc/researchGate.js';
import { normalizeOfficialPosting } from '../../../electron/ipc/officialPostingFields.js';
import { officialPostingPreparationSourceKey, projectOfficialPostingGenerationJob } from '../../utils/officialPostingPreparation.js';
import { refreshBoardOfficialPostingJobs } from '../../utils/jobBoardOfficialPostingRefresh.js';

const RESCORED_FIELDS = ['matchScore', 'rawScore', 'adjustedScore', 'reasoning', 'careerDirection', 'requirementAssessments',
  'materialGaps', 'confidence', 'strengths', 'experienceAssessment', 'fitAssessment', 'scoreStatus', 'officialRescore'];
const sourceKey = job => officialPostingPreparationSourceKey(projectOfficialPostingGenerationJob(job));
const ruleKeys = assessment => (Array.isArray(assessment?.matches) ? assessment.matches : []).map(match => `${match?.preferenceId}\u0000${match?.criterion}`).sort().join('\u0001');

/**
 * Accepted Board work on a card for this exact source: a rescore of the same
 * official text on the same career record, and finished company research on the
 * same rules. An edited brief owes its new company rules their own research.
 */
export function carryBoardRescores(jobs, cards) {
  const bySource = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card?.type === 'jobcard' && (card.data?.officialRescore?.contentHash || card.data?.preferenceAssessment)) bySource.set(sourceKey(card.data), card.data);
  }
  return (Array.isArray(jobs) ? jobs : []).map(job => {
    const card = bySource.size ? bySource.get(sourceKey(job)) : null;
    if (!card) return job;
    let carried = job;
    if (job?.preferenceAssessment?.companyResearchPending && card.preferenceAssessment && !card.preferenceAssessment.companyResearchPending
      && ruleKeys(card.preferenceAssessment) === ruleKeys(job.preferenceAssessment)) {
      carried = { ...carried, preferenceAssessment: card.preferenceAssessment };
    }
    if (card.officialRescore?.contentHash && card.officialRescore.contentHash === normalizeOfficialPosting(job?.officialPosting)?.contentHash
      && card.officialRescore.careerSnapshotId === job?.scoringEvidenceReceipt?.careerSnapshotId) {
      carried = { ...carried };
      for (const field of RESCORED_FIELDS) {
        if (card[field] === undefined) delete carried[field];
        else carried[field] = card[field];
      }
    }
    return carried;
  });
}

/**
 * The one automatic research stage: official lookup for rows at or above the
 * fit threshold, then the host's listing, dedup, rescore and company checks.
 * Rows below the threshold reach neither call's research. Protected cards stay
 * through any removal, so an application-linked card is never lost.
 */
export async function runBoardResearchStage(union, {
  nodeId, manualAiRunId, existingCards = [], protectedIds = new Set(), cancelled = () => false,
  refresh, settle, onProgress = () => {},
}) {
  const rows = carryBoardRescores(union, existingCards);
  const eligibleIndexes = rows.flatMap((job, index) => (isResearchEligible(job) ? [index] : []));
  const lookupLabel = (completed, total) => `Researching jobs at ${RESEARCH_MIN_FIT_SCORE} or above: ${completed} of ${total}, ${rows.length - total} below skipped`;
  onProgress({ label: lookupLabel(0, eligibleIndexes.length) });
  const refreshed = await refreshBoardOfficialPostingJobs(eligibleIndexes.map(index => rows[index]), {
    nodeId, manualAiRunId, force: true, cancelled, refresh,
    onProgress: ({ completed, total }) => onProgress({ label: lookupLabel(completed, total) }),
  });
  const merged = rows.slice();
  eligibleIndexes.forEach((index, position) => { merged[index] = refreshed.jobs[position]; });
  if (cancelled()) return { cancelled: true };
  onProgress({ label: `Checking ${eligibleIndexes.length} researched job(s)` });
  const settled = await settle({ jobs: merged, nodeId, manualAiRunId, officialLookups: eligibleIndexes.length });
  if (cancelled()) return { cancelled: true };
  if (!settled?.success || !Array.isArray(settled.jobs) || settled.jobs.length !== merged.length) {
    if (settled?.cancelled) return { cancelled: true };
    throw Object.assign(new Error(settled?.error || 'Board research failed.'), { code: settled?.errorCode });
  }
  const isProtected = job => protectedIds.has(job?.cardId ?? job?.id) || !!job?.localApplication;
  const removed = new Set((settled.dropped || []).filter(({ index }) => !isProtected(settled.jobs[index])).map(({ index }) => index));
  return { jobs: settled.jobs.filter((_job, index) => !removed.has(index)), counts: settled.counts, removed: removed.size };
}
