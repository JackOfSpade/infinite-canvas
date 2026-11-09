import { isResearchEligible, RESEARCH_MIN_FIT_SCORE } from '../../../electron/ipc/researchGate.js';
import { COMPANY_RESEARCH_VERSION } from '../../../electron/ipc/companyResearchVersion.js';
import { normalizeOfficialPosting, officialPostingExhausted } from '../../../electron/ipc/officialPostingFields.js';
import { officialPostingPreparationSourceKey, projectOfficialPostingGenerationJob } from '../../utils/officialPostingPreparation.js';
import { refreshBoardOfficialPostingJobs } from '../../utils/jobBoardOfficialPostingRefresh.js';
import { officialPostingNeedsRefresh } from '../../utils/officialPostingDisplay.js';

const RESCORED_FIELDS = ['matchScore', 'rawScore', 'adjustedScore', 'reasoning', 'careerDirection', 'requirementAssessments',
  'materialGaps', 'confidence', 'strengths', 'experienceAssessment', 'fitAssessment', 'scoreStatus', 'officialRescore'];
const sourceKey = job => officialPostingPreparationSourceKey(projectOfficialPostingGenerationJob(job));
const MAX_REMOVED_LOOKUPS = 256;
// A collision would hand one job another job's lookup, so this is a real digest.
async function sourceDigest(job) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceKey(job)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
// Only a finished lookup may stand in for research: an incomplete one could
// have caused the removal, and a fresh attempt might keep the job.
const finishedLookup = value => {
  const posting = normalizeOfficialPosting(value);
  return posting && !officialPostingNeedsRefresh({ officialPosting: posting }) ? posting : null;
};
/** What a later Combine needs to skip re-researching a row this Board removed, or null. */
export async function removedLookupEntry(job) {
  const posting = finishedLookup(job?.officialPosting);
  return posting ? { key: await sourceDigest(job), officialPosting: posting, postedBy: job.postedBy } : null;
}
export const MAX_BOARD_REMOVED_LOOKUPS = MAX_REMOVED_LOOKUPS;
const ruleKeys = assessment => (Array.isArray(assessment?.matches) ? assessment.matches : []).map(match => `${match?.preferenceId}\u0000${match?.criterion}`).sort().join('\u0001');

/**
 * Accepted Board work on a card for this exact source: a rescore of the same
 * official text on the same career record, and finished company research on the
 * same rules from the current research version. An edited brief owes its new
 * company rules their own research, and older research is asked again.
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
      && card.preferenceAssessment.companyResearchVersion === COMPANY_RESEARCH_VERSION
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
 * Rows below the threshold reach neither call's research, and neither does a
 * lookup that twice ended without a conclusion on this source.
 * Protected cards stay through any removal, so an application-linked card is never lost.
 * A row the previous Combine of these same runs removed has no card to carry its
 * lookup, so `removedLookups` carries it instead of researching it again.
 */
export async function runBoardResearchStage(union, {
  nodeId, manualAiRunId, existingCards = [], protectedIds = new Set(), cancelled = () => false,
  refresh, settle, onProgress = () => {}, removedLookups = null,
}) {
  const rows = carryBoardRescores(union, existingCards);
  const eligibleIndexes = rows.flatMap((job, index) => (isResearchEligible(job) ? [index] : []));
  const savedRemovals = new Map((Array.isArray(removedLookups) ? removedLookups : []).map(entry => [entry?.key, entry]));
  const reusedIndexes = new Set();
  if (savedRemovals.size) {
    const cardKeys = new Set(existingCards.filter(card => card?.type === 'jobcard' && card.data).map(card => sourceKey(card.data)));
    for (const index of eligibleIndexes) {
      if (cardKeys.has(sourceKey(rows[index]))) continue;
      const saved = savedRemovals.get(await sourceDigest(rows[index]));
      const posting = finishedLookup(saved?.officialPosting);
      if (!posting) continue;
      rows[index] = { ...rows[index], officialPosting: posting, postedBy: saved.postedBy };
      reusedIndexes.add(index);
    }
  }
  const lookupIndexes = eligibleIndexes.filter(index => !reusedIndexes.has(index) && !officialPostingExhausted(rows[index]?.officialPosting));
  const lookupLabel = (completed, total) => `Researching jobs at ${RESEARCH_MIN_FIT_SCORE} or above: ${completed} of ${total}, ${rows.length - eligibleIndexes.length} below skipped`;
  onProgress({ label: lookupLabel(0, lookupIndexes.length) });
  const refreshed = await refreshBoardOfficialPostingJobs(lookupIndexes.map(index => rows[index]), {
    nodeId, manualAiRunId, force: true, cancelled, refresh,
    onProgress: ({ completed, total }) => onProgress({ label: lookupLabel(completed, total) }),
  });
  const merged = rows.slice();
  lookupIndexes.forEach((index, position) => { merged[index] = refreshed.jobs[position]; });
  if (cancelled()) return { cancelled: true };
  onProgress({ label: `Checking ${eligibleIndexes.length} researched job(s)` });
  const settled = await settle({ jobs: merged, nodeId, manualAiRunId, officialLookups: lookupIndexes.length });
  if (cancelled()) return { cancelled: true };
  if (!settled?.success || !Array.isArray(settled.jobs) || settled.jobs.length !== merged.length) {
    if (settled?.cancelled) return { cancelled: true };
    throw Object.assign(new Error(settled?.error || 'Board research failed.'), { code: settled?.errorCode });
  }
  const isProtected = job => protectedIds.has(job?.cardId ?? job?.id) || !!job?.localApplication;
  const removed = new Set((settled.dropped || []).filter(({ index }) => !isProtected(settled.jobs[index])).map(({ index }) => index));
  const eligible = new Set(eligibleIndexes);
  const nextRemovedLookups = [];
  for (const index of removed) {
    const posting = eligible.has(index) ? finishedLookup(settled.jobs[index]?.officialPosting) : null;
    if (!posting || nextRemovedLookups.length >= MAX_REMOVED_LOOKUPS) continue;
    nextRemovedLookups.push({ key: await sourceDigest(rows[index]), officialPosting: posting, postedBy: settled.jobs[index].postedBy });
  }
  return { jobs: settled.jobs.filter((_job, index) => !removed.has(index)), counts: settled.counts, removed: removed.size,
    pausedRetries: eligibleIndexes.length - lookupIndexes.length - reusedIndexes.size,
    reusedRemovals: reusedIndexes.size, removedLookups: nextRemovedLookups };
}
