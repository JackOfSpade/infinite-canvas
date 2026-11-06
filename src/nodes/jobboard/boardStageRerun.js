// Single-stage Board reruns work on the cards a Board already shows, unlike
// Combine, which rebuilds rows from the connected Searches. These pure helpers
// turn cards back into the rows each stage's existing IPC already accepts, and
// decide which card fields a stage may write back.
import { sourceJobKey } from '../../utils/jobIdentity.js';
import { normalizeJobMatchScore } from './mergeJobs.js';
import { isJobWorkflowDeletionPending } from '../../utils/nodeDeletionLifecycle.js';

export const BOARD_STAGES = Object.freeze({
  compensation: { label: 'Update salary analysis', button: 'Salary', progressLabel: 'Updating salary', queueKind: 'board-salary-refresh' },
  listings: { label: 'Re-check listings', button: 'Listings', progressLabel: 'Checking listings', queueKind: 'board-listing-refresh' },
  regroup: { label: 'Re-sort board', button: 'Grouping', progressLabel: 'Sorting board', queueKind: 'board-regroup' },
});

/** The Board's own, editable job cards (locked or deleting cards are left alone). */
export function boardStageCards(nodes, boardId) {
  return (Array.isArray(nodes) ? nodes : []).filter(node => node?.type === 'jobcard'
    && node.data?.hubId === boardId && !node.data.locked && !isJobWorkflowDeletionPending(node.id));
}

function cardSourceKey(data) {
  return data?.sourceJobKey || sourceJobKey(data);
}

/**
 * Cards drop the scorer's internal salary context (compensationContext) and
 * each Search's saved remote residences. Recover both from the card's origin
 * Search row, matched by the same source key Combine used, so a salary rerun
 * researches the same cohort a Combine would. A card whose source row is gone
 * still works; the host falls back to the card's own title and location.
 */
export function compensationRowsFromCards(cards, modules) {
  const byModule = new Map();
  for (const module of Array.isArray(modules) ? modules : []) {
    const rows = new Map();
    for (const row of Array.isArray(module?.scoredJobs) ? module.scoredJobs : []) {
      const key = cardSourceKey(row);
      if (key && !rows.has(key)) rows.set(key, row);
    }
    byModule.set(module.id, { rows, remoteResidences: module.remoteResidences || {} });
  }
  let matched = 0;
  const rows = cards.map(card => {
    const origin = byModule.get(card.data.originHubId);
    const source = origin?.rows.get(cardSourceKey(card.data));
    if (source) matched++;
    // Combine researches a row rescored on official text without the
    // scorer's original context (the rescore discards it); do the same.
    const context = card.data.officialRescore ? null : source?.compensationContext;
    const { compensationAssessment: _previous, compensationCareerSnapshotId: _previousSnapshot, ...data } = card.data;
    return {
      ...data,
      ...(context ? { compensationContext: context } : {}),
      compensationRemoteResidences: origin?.remoteResidences || {},
    };
  });
  return { rows, matched };
}

/** The exact projection Combine sends to taxonomy, in card order. */
export function taxonomyRowsFromCards(rows) {
  return rows.map(job => ({
    careerDirection: job.careerDirection || '',
    matchScore: normalizeJobMatchScore(job.matchScore),
    salary: job.salary || '',
    title: job.title || '',
    source: job.source || '',
  }));
}

/** A card row for a rebuild: its own data, reusing its id, position and state. */
export function rebuildRowFromCard(card) {
  return { ...card.data, reuseCardId: card.id };
}

/** Snapshot of what a stage read from a card, to detect a concurrent change before writing back. */
export function stageCardSnapshot(card, fields) {
  return { id: card.id, key: cardSourceKey(card.data), values: JSON.stringify(fields.map(field => card.data[field] ?? null)) };
}

export function stageCardUnchanged(node, snapshot, boardId, fields) {
  return node?.type === 'jobcard' && node.data?.hubId === boardId && !node.data.locked
    && cardSourceKey(node.data) === snapshot.key
    && JSON.stringify(fields.map(field => node.data[field] ?? null)) === snapshot.values;
}

export const COMPENSATION_FIELDS = ['compensationAssessment', 'compensationCareerSnapshotId'];

// Everything the host's listing settlement can change on a kept row. The
// rescore fields mirror jobBoardResearchStage.js; the rest are the listing,
// dedup and company-research results.
export const LISTING_FIELDS = ['matchScore', 'rawScore', 'adjustedScore', 'reasoning', 'careerDirection', 'requirementAssessments',
  'materialGaps', 'confidence', 'strengths', 'experienceAssessment', 'fitAssessment', 'scoreStatus', 'officialRescore',
  'listingLiveness', 'boardClosed', 'preferenceAssessment', 'officialPosting', 'postedBy', 'alternateListings'];

export function compensationPatch(row) {
  return {
    compensationAssessment: row.compensationAssessment,
    compensationCareerSnapshotId: row.compensationAssessment?.personalRecommendation?.careerSnapshotId ?? null,
  };
}

export function listingPatch(row, card) {
  const patch = {};
  for (const field of LISTING_FIELDS) {
    if (JSON.stringify(row[field] ?? null) !== JSON.stringify(card.data[field] ?? null)) patch[field] = row[field];
  }
  return patch;
}

const postedSalaryText = data => String(data?.officialPosting?.salary?.text ?? data?.officialPosting?.salary ?? '');

/** Whether a listing check moved a card's hiring fit, role or posted pay, so its group may be wrong. */
export function listingChangedGrouping(rows, cards) {
  return rows.some((row, index) => normalizeJobMatchScore(row.matchScore) !== normalizeJobMatchScore(cards[index].data.matchScore)
    || (row.careerDirection || '') !== (cards[index].data.careerDirection || '')
    || postedSalaryText(row) !== postedSalaryText(cards[index].data));
}

// Salary analysis reads the fit audit: a rescore that changes any of these
// leaves the card's salary answer built on the old inputs.
const SALARY_INPUT_FIELDS = ['matchScore', 'fitAssessment', 'experienceAssessment', 'officialPosting'];

export function listingChangedSalaryInputs(rows, cards) {
  return rows.some((row, index) => SALARY_INPUT_FIELDS.some(field =>
    JSON.stringify(row[field] ?? null) !== JSON.stringify(cards[index].data[field] ?? null)));
}

/** Source pills count only the cards still on the Board. */
export function finalSourceCountsOf(rows) {
  const counts = {};
  for (const row of rows) counts[row.source] = (counts[row.source] || 0) + 1;
  return counts;
}
