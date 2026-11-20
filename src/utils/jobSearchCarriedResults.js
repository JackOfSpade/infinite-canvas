// A Job Board search that scrapes a finished Search again ADDS the new jobs to
// the ones that same Board is still showing, instead of replacing them. The
// decision is made once, when the run starts, and saved on the Search card
// (`carriedResults`), so a pause, crash or app restart finishes the run the
// same way. Every terminal commit of that run then merges the earlier rows.
//
// When the Board that showed the earlier jobs is gone (deleted) or a different
// Board asks, nothing is carried: those jobs count as reviewed and the new run
// replaces them, so they are never shown a second time.

import { jobSearchShownRun } from './jobBoardSourceAdmission.js';
import { normalizedJobCareerSnapshotId } from './jobCareerSnapshotBinding.js';
import { uniqueJobsAcrossSources } from './jobIdentity.js';

function savedRows(data) {
  return Array.isArray(data?.scoredJobs) ? data.scoredJobs.filter(Boolean) : [];
}

/**
 * The marker a run writes at its start: which earlier run's rows it keeps, and
 * for which Board. Null when nothing is carried.
 */
export function jobSearchCarriedResultsMarker(data, { orchestratorNodeId = null } = {}) {
  if (typeof orchestratorNodeId !== 'string' || !orchestratorNodeId) return null;
  const careerSnapshotId = normalizedJobCareerSnapshotId(data?.careerSnapshotId);
  if (!careerSnapshotId || savedRows(data).length === 0) return null;
  const shown = jobSearchShownRun(data);
  if (shown) {
    return shown.boardId === orchestratorNodeId
      ? { runId: shown.runId, boardId: shown.boardId, careerSnapshotId }
      : null;
  }
  // An earlier attempt of this same re-scan cleared or replaced the run id
  // (it failed or paused before committing rows); the rows on the card are
  // still the shown ones, so its marker carries on.
  const prior = data?.carriedResults;
  if (
    prior
    && typeof prior.runId === 'string' && prior.runId
    && prior.boardId === orchestratorNodeId
    && prior.careerSnapshotId === careerSnapshotId
  ) {
    return { runId: prior.runId, boardId: prior.boardId, careerSnapshotId };
  }
  return null;
}

/**
 * The earlier rows a terminal commit of run `jobRunId` keeps. Only rows scored
 * under the same approved career snapshot are kept; a career change re-scores
 * through its own path instead.
 */
export function carriedJobsForTerminal(data, { jobRunId = null, careerSnapshotId = null } = {}) {
  const marker = data?.carriedResults;
  const snapshot = normalizedJobCareerSnapshotId(careerSnapshotId);
  if (
    !marker
    || typeof jobRunId !== 'string' || !jobRunId
    || marker.runId === jobRunId
    || !snapshot
    || marker.careerSnapshotId !== snapshot
  ) return [];
  return savedRows(data).filter(job => normalizedJobCareerSnapshotId(job?.careerSnapshotId) === snapshot);
}

/**
 * The rows a terminal commit that adds nothing new will hold, so its receipt
 * fingerprint matches the card (terminal-finalization retry compares them).
 */
export function carriedTerminalRows(data, { jobRunId = null, careerSnapshotId = null } = {}) {
  return mergeCarriedJobs([], carriedJobsForTerminal(data, { jobRunId, careerSnapshotId }));
}

/** New rows first, then each kept row that is not the same listing as a new one. */
export function mergeCarriedJobs(newRows, carriedRows) {
  const fresh = Array.isArray(newRows) ? newRows : [];
  const kept = Array.isArray(carriedRows) && carriedRows.length > 0
    ? uniqueJobsAcrossSources(fresh, carriedRows)
    : [];
  return kept.length > 0 ? [...fresh, ...kept] : fresh;
}

function summaryOf(rows) {
  const finalSourceCounts = {};
  rows.forEach((job) => { finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1; });
  const scores = rows.map(job => job.matchScore || 0);
  return {
    finalSourceCounts,
    scoreRangeMin: scores.length ? Math.min(...scores) : 0,
    scoreRangeMax: scores.length ? Math.max(...scores) : 100,
  };
}

/**
 * Apply the carry to a terminal patch that commits no new rows (zero results
 * or every new row filtered out). The run's own disposition stays: it found
 * nothing new. The card keeps the earlier rows the Board is still showing.
 * Always clears the marker, carried or not.
 */
export function withCarriedJobsTerminalPatch(data, patch, { careerSnapshotId = null, jobRunId = undefined } = {}) {
  if (!patch || typeof patch !== 'object') return patch;
  const runId = jobRunId === undefined ? (patch.jobRunId ?? null) : jobRunId;
  const carried = carriedJobsForTerminal(data, { jobRunId: runId, careerSnapshotId });
  if (carried.length === 0) return { ...patch, carriedResults: null, carriedJobCount: 0 };
  const rows = mergeCarriedJobs(Array.isArray(patch.scoredJobs) ? patch.scoredJobs : [], carried);
  return {
    ...patch,
    ...summaryOf(rows),
    scoredJobs: rows,
    resultCount: rows.length,
    totalScoredCount: rows.length,
    carriedResults: null,
    carriedJobCount: rows.length - (Array.isArray(patch.scoredJobs) ? patch.scoredJobs.length : 0),
  };
}
