// Process-local registry of saved-scrape analyses that a Job Search card can
// still resume. It is deliberately never persisted into node data: the durable
// snapshot on disk remains the only source of truth, this registry only makes
// the in-memory renderer state observable to a connected Job Board.
import { classifyJobBoardSourceAdmission } from './jobBoardSourceAdmission.js';

const AVAILABILITY = new Map();
const LISTENERS = new Set();
let availabilityVersion = 0;

function normalizedId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Only entries that describe at least one resumable saved job are meaningful.
// Anything else (null, zero jobs, no career snapshot) means "nothing to resume".
function normalizeEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const careerSnapshotId = normalizedId(entry.careerSnapshotId);
  const jobCount = entry.jobCount;
  if (!careerSnapshotId) return null;
  if (typeof jobCount !== 'number' || !Number.isFinite(jobCount) || jobCount <= 0) return null;
  return Object.freeze({ careerSnapshotId, jobCount: Math.floor(jobCount) });
}

function sameEntry(left, right) {
  if (!left || !right) return left === right;
  return left.careerSnapshotId === right.careerSnapshotId && left.jobCount === right.jobCount;
}

function notifyListeners() {
  for (const listener of [...LISTENERS]) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the other subscribers (or the caller).
    }
  }
}

/**
 * Publish (or clear, with `null`) the resumable saved analysis of one Job
 * Search card. Republishing an identical entry is a no-op so subscribers and
 * `useSyncExternalStore` consumers are not re-rendered for nothing.
 * Returns true when the registry actually changed.
 */
export function publishSavedAnalysisAvailability(nodeId, entry = null) {
  const key = normalizedId(nodeId);
  if (!key) return false;
  const next = normalizeEntry(entry);
  const current = AVAILABILITY.get(key) || null;
  if (sameEntry(current, next)) return false;
  if (next) AVAILABILITY.set(key, next);
  else AVAILABILITY.delete(key);
  availabilityVersion += 1;
  notifyListeners();
  return true;
}

export function getSavedAnalysisAvailability(nodeId) {
  const key = normalizedId(nodeId);
  return (key && AVAILABILITY.get(key)) || null;
}

export function subscribeSavedAnalysisAvailability(listener) {
  if (typeof listener !== 'function') return () => {};
  LISTENERS.add(listener);
  return () => {
    LISTENERS.delete(listener);
  };
}

export function getSavedAnalysisAvailabilityVersion() {
  return availabilityVersion;
}

/**
 * Pure decision: may its Job Board resume this card's saved scrape instead of
 * asking for a destructive "Clear career data"? Only the exact deadlock case
 * qualifies: an empty hub whose already-consumed career import blocks a fresh
 * scan, with a matching non-empty saved analysis and a stored profile to score
 * against.
 */
export function savedAnalysisResumeAdmission(node, entry) {
  if (node?.type !== 'jobhub') {
    return { ok: false, reason: 'This module is not a connected Job Search card.' };
  }
  const data = isPlainObject(node.data) ? node.data : {};
  if ((data.hubState || 'empty') !== 'empty') {
    return { ok: false, reason: 'This Job Search is not in an empty state that needs its saved jobs back.' };
  }
  if (!isPlainObject(entry)) {
    return { ok: false, reason: 'No saved job analysis is available for this Job Search.' };
  }
  const jobCount = entry.jobCount;
  if (typeof jobCount !== 'number' || !Number.isFinite(jobCount) || jobCount <= 0) {
    return { ok: false, reason: 'Its saved job analysis has no saved jobs to score.' };
  }
  const entrySnapshotId = typeof entry.careerSnapshotId === 'string' ? entry.careerSnapshotId : '';
  const nodeSnapshotId = String(data.careerSnapshotId || '');
  if (!entrySnapshotId || entrySnapshotId !== nodeSnapshotId) {
    return { ok: false, reason: 'Its saved job analysis belongs to different career data.' };
  }
  if (!isPlainObject(data.resumeProfile)) {
    return { ok: false, reason: 'This Job Search has no stored career profile to score its saved jobs with.' };
  }
  if (data.manualAiResume?.runId) {
    return { ok: false, reason: 'This Job Search still has a saved AI handoff to resolve first.' };
  }
  const admission = classifyJobBoardSourceAdmission(node);
  if (admission.kind !== 'fresh-import-requires-clear') {
    return {
      ok: false,
      reason: admission.reason || 'This Job Search does not need its saved jobs resumed.',
    };
  }
  return { ok: true, jobCount: Math.floor(jobCount) };
}
