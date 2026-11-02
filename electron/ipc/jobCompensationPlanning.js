import {
  BATCH_OUTPUT_TOKEN_BUDGET,
  compensationCohortAssessmentFits,
  MAX_ROLE_FAMILIES_PER_ASSESSMENT,
} from './resultCaps.js';

// Claude's official output limit (see BATCH_OUTPUT_TOKEN_BUDGET in
// resultCaps.js) bounds each call. A raw research call has a 2,048-token floor.
// A role ladder has a ~1,800-token research allowance, and a salary cohort
// needs materially more independent evidence (~3,000 tokens), so each batch
// holds as many as fit the budget. These are output safety limits, not
// input-context limits.
const RAW_RESEARCH_BASE_TOKENS = 2048;
const ROLE_FAMILY_RESEARCH_TOKENS = 1800;
const COMPENSATION_COHORT_RESEARCH_TOKENS = 3000;
export const ROLE_FAMILY_HANDOFF_BATCH_SIZE = Math.floor(
  (BATCH_OUTPUT_TOKEN_BUDGET - RAW_RESEARCH_BASE_TOKENS) / ROLE_FAMILY_RESEARCH_TOKENS,
);
export const COMPENSATION_COHORT_HANDOFF_BATCH_SIZE = Math.floor(
  (BATCH_OUTPUT_TOKEN_BUDGET - RAW_RESEARCH_BASE_TOKENS) / COMPENSATION_COHORT_RESEARCH_TOKENS,
);

function planRoleFamilyBatches(entries, batchSize) {
  const ordered = Array.isArray(entries) ? entries : [];
  const batchTotal = Math.ceil(ordered.length / batchSize);
  const batches = [];
  for (let start = 0; start < ordered.length; start += batchSize) {
    const batch = ordered.slice(start, start + batchSize);
    const cachedEntries = batch.filter(entry => entry?.cached);
    batches.push({
      batch,
      batchNumber: Math.floor(start / batchSize) + 1,
      batchTotal,
      cachedEntries,
      missingEntries: batch.filter(entry => !entry?.cached),
    });
  }
  return batches;
}

/**
 * Partition the complete ordered role-family plan before consulting any
 * batch-local cache outcome. Durable handoff identity includes batch ordinal
 * and total, so removing accepted entries before slicing would renumber a
 * pending later paste after restart.
 */
export function planRoleFamilyResearchBatches(entries) {
  return planRoleFamilyBatches(entries, ROLE_FAMILY_HANDOFF_BATCH_SIZE);
}

/**
 * The compact ladder extraction can carry twenty identities even though the
 * preceding grounded-web phase carries seven. Build this complete stable plan
 * before accepting any result: a restart after assessment one must not move a
 * still-pending assessment's ids or ordinal merely because cached ladders now
 * exist. Whole cached slices are skipped by the caller; partial slices retain
 * their cached identities as inert validation rows.
 */
export function planRoleFamilyAssessmentBatches(entries) {
  return planRoleFamilyBatches(entries, MAX_ROLE_FAMILIES_PER_ASSESSMENT);
}

/**
 * Deterministically pack bounded compensation assessments. Fresh raw-research
 * batches additionally set `oneRawSectionPerResearchKey`: row chunks from one
 * large cohort then appear in later batches, where they reuse its first raw
 * section instead of asking the user to research the same market again.
 */
export function packCompensationAssessmentBatches(entries, { oneRawSectionPerResearchKey = false } = {}) {
  const batches = [];
  let current = [];
  let rows = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const entryRows = Array.isArray(entry?.group?.jobs) ? entry.group.jobs.length : 0;
    const nextCohorts = current.length + 1;
    const nextRows = rows + entryRows;
    const fits = (!oneRawSectionPerResearchKey || !current.some(item => item.researchKey === entry.researchKey))
      && compensationCohortAssessmentFits(nextCohorts, nextRows);
    if (current.length && !fits) {
      batches.push(current);
      current = [];
      rows = 0;
    }
    current.push(entry);
    rows += entryRows;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Grounded market research has a different (cohort-count) output shape from
 * its compact, row-aware extraction. Keep this phase separate so a small
 * downstream assessment does not unnecessarily shrink a full raw
 * handoff. Duplicate row-parts of one market are deliberately separated: the
 * later part reuses the first accepted raw section instead of researching the
 * same market twice.
 */
export function packCompensationResearchBatches(entries) {
  const batches = [];
  let current = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const fits = current.length < COMPENSATION_COHORT_HANDOFF_BATCH_SIZE
      && !current.some(item => item.researchKey === entry?.researchKey);
    if (current.length && !fits) {
      batches.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length) batches.push(current);
  return batches;
}
