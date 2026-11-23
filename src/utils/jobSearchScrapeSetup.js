import { ACTIVE_JOB_SOURCES } from './constants.js';
import { hubHasAcceptedInitialDrop } from './hubDropEligibility.js';
import { getJobAuthPreflightSourceIds } from './jobAuthPreflight.js';
import { normalizeJobCollectionLimits } from './jobCollectionLimits.js';
import { getRunnableJobSourceIds, normalizeEnabledJobSourceIds } from './jobPlatformSelection.js';
import { getSearchLocation, hasRequiredLocations, locationValidationMessage } from './jobSearchLocations.js';

/**
 * The setup a Job Search needs before a provider scrape can start: a runnable
 * platform, accepted career files and the required search location. Returns
 * null when a scrape may start, or the Board readiness entry that names what
 * is missing. `verifyingPlatforms` is the live set of platforms whose login
 * checks are still running.
 */
export function jobSearchScrapeSetupProblem(node, { verifyingPlatforms = null } = {}) {
  const sourceData = node?.data || {};
  const runnableSources = getRunnableJobSourceIds(
    normalizeEnabledJobSourceIds(sourceData.enabledSourceIds),
    ACTIVE_JOB_SOURCES,
    normalizeJobCollectionLimits(sourceData.collectionLimits),
  );
  const browserLoginSources = getJobAuthPreflightSourceIds(
    sourceIds => sourceIds.filter(sourceId => runnableSources.includes(sourceId)),
  );
  if (verifyingPlatforms instanceof Set && browserLoginSources.some(sourceId => verifyingPlatforms.has(sourceId))) {
    return {
      ready: false,
      readinessReason: 'Its selected platform connections are still being checked.',
      statusLabel: 'Checking connections',
    };
  }
  if (runnableSources.length === 0) {
    return { ready: false, readinessReason: 'Select at least one job platform.', statusLabel: 'Needs platform' };
  }
  if (!hubHasAcceptedInitialDrop(node)) {
    return { ready: false, readinessReason: 'Drop career files on this module first.', statusLabel: 'Needs files' };
  }
  const searchLocation = getSearchLocation(sourceData);
  if (!hasRequiredLocations(searchLocation)) {
    return {
      ready: false,
      readinessReason: locationValidationMessage(searchLocation),
      statusLabel: 'Needs location',
    };
  }
  return null;
}
