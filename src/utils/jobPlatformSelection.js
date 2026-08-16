import { ALL_JOB_SOURCE_IDS } from './constants.js';
import { getUnsafeJobPlatformIds } from './jobPlatformSafety.js';

/**
 * Normalizes a Job Search hub's persisted source allow-list.
 *
 * Missing data is deliberately treated as every known source: canvases saved
 * before source selection existed retain their current all-platform behavior.
 */
export function normalizeEnabledJobSourceIds(sourceIds, knownIds = ALL_JOB_SOURCE_IDS) {
  const known = Array.isArray(knownIds) ? knownIds.filter(Boolean) : [];
  if (!Array.isArray(sourceIds)) return [...known];
  const allowed = new Set(known);
  return [...new Set(sourceIds.filter(id => allowed.has(id)))];
}

/** Return the persisted selection narrowed to the sources available this run. */
export function getEnabledJobSourceIds(sourceIds, availableIds = ALL_JOB_SOURCE_IDS) {
  const available = Array.isArray(availableIds) ? availableIds.filter(Boolean) : [];
  const selected = new Set(normalizeEnabledJobSourceIds(sourceIds));
  return available.filter(id => selected.has(id));
}

export function isJobSourceSelected(sourceId, sourceIds, availableIds = ALL_JOB_SOURCE_IDS) {
  return getEnabledJobSourceIds(sourceIds, availableIds).includes(sourceId);
}

/** The exact source set a run may execute after selection, scope, and safety. */
export function getRunnableJobSourceIds(sourceIds, availableIds = ALL_JOB_SOURCE_IDS, collectionLimits = null) {
  const selected = getEnabledJobSourceIds(sourceIds, availableIds);
  const unsafe = new Set(getUnsafeJobPlatformIds(collectionLimits, selected));
  return selected.filter(sourceId => !unsafe.has(sourceId));
}
