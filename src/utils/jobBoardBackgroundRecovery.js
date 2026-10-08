import { ACTIVE_JOB_SOURCES } from './constants.js';
import { normalizeJobCollectionLimits } from './jobCollectionLimits.js';
import { flattenJobSearchQueries } from './jobSearchQueries.js';
import {
  jobSearchNextAnchor,
  normalizeJobSearchInitialLookbackDays,
  resolveJobSearchDateWindow,
} from './jobSearchDateWindow.js';
import { getSearchLocation, locationToLegacyText } from './jobSearchLocations.js';
import { getRunnableJobSourceIds, normalizeEnabledJobSourceIds } from './jobPlatformSelection.js';
import { buildJobCareerQueryCacheKey, careerSnapshotBindingMatches, normalizedJobCareerSnapshotId } from './jobCareerSnapshotBinding.js';

const BACKGROUND_SAFE_SOURCE_IDS = new Set([
  'linkedin', 'remoteok', 'weworkremotely', 'dice', 'usajobs',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function profileFingerprint(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

export function backgroundBoardChildInputKey(node) {
  const data = node?.data || {};
  return stableJson({
    id: node?.id || null,
    locked: !!data.locked,
    careerSnapshotId: data.careerSnapshotId || null,
    careerDerivedSnapshotId: data.careerDerivedSnapshotId || null,
    queryCareerSnapshotId: data.queryCareerSnapshotId || null,
    preferenceCareerSnapshotId: data.preferenceCareerSnapshotId || null,
    scoringCareerSnapshotId: data.scoringCareerSnapshotId || null,
    resumeFingerprint: data.resumeFingerprint || null,
    hasResumeProfile: !!(data.resumeProfile && typeof data.resumeProfile === 'object'),
    jobPreferences: data.jobPreferences || '',
    searchBriefPlan: data.searchBriefPlan || data.jobPreferencePlan || null,
    resolvedRolesMeta: data.resolvedRolesMeta || null,
    queries: data.queries || null,
    queryCacheKey: data.queryCacheKey || null,
    canonicalLocation: data.canonicalLocation || null,
    preferredLocation: data.preferredLocation || null,
    searchLocation: data.searchLocation || null,
    canonicalCountry: data.canonicalCountry || null,
    enabledSourceIds: data.enabledSourceIds || null,
    collectionLimits: data.collectionLimits || null,
    lastSearchCoverageStartedAt: data.lastSearchCoverageStartedAt || null,
    lastCompletedRunAt: data.lastCompletedRunAt || null,
    jobRunId: data.jobRunId || null,
    partialCollectionRunId: data.partialCollectionRunId || null,
    initialLookbackDays: data.initialLookbackDays ?? data.maxAgeDays ?? null,
  });
}

/**
 * Freeze the narrow work a hidden Board may start between children. This is
 * intentionally available only when query planning is already cached and
 * every selected provider is unattended-safe. Anything requiring login,
 * native Chrome, CAPTCHA, query generation, or role interpretation remains a
 * mounted/human boundary.
 */
export function prepareBackgroundBoardChildRequest({
  node,
  boardNodeId,
  boardRunId,
  startedAt,
  canvasFilePath,
} = {}) {
  const data = node?.data || {};
  const fingerprint = profileFingerprint(data.resumeFingerprint);
  const careerSnapshotId = normalizedJobCareerSnapshotId(data.careerSnapshotId);
  const clock = Number.isSafeInteger(startedAt) && startedAt > 0 ? new Date(startedAt) : null;
  const searchLocation = getSearchLocation(data);
  const preferredLocation = locationToLegacyText(searchLocation);
  const queries = flattenJobSearchQueries(data.queries);
  const collectionLimits = normalizeJobCollectionLimits(data.collectionLimits);
  const enabledSourceIds = normalizeEnabledJobSourceIds(data.enabledSourceIds);
  const runnableSourceIds = getRunnableJobSourceIds(
    enabledSourceIds,
    ACTIVE_JOB_SOURCES,
    collectionLimits,
  );
  const preferencePlan = data.searchBriefPlan || data.jobPreferencePlan || null;
  if (
    node?.type !== 'jobhub'
    || !node.id
    || !boardNodeId
    || !boardRunId
    || !canvasFilePath
    || !clock
    || !Number.isFinite(clock.getTime())
    || data.locked
    || data.manualAiResume?.runId
    || data.terminalFinalizationRecovery
    || !(data.resumeProfile && typeof data.resumeProfile === 'object')
    || !fingerprint
    || !careerSnapshotId
    || !careerSnapshotBindingMatches({ careerSnapshotId: data.careerDerivedSnapshotId }, careerSnapshotId)
    || !careerSnapshotBindingMatches({ careerSnapshotId: data.queryCareerSnapshotId }, careerSnapshotId)
    || !careerSnapshotBindingMatches(data.resolvedRolesMeta, careerSnapshotId)
    || (Array.isArray(data.scoredJobs) && data.scoredJobs.length > 0 && (
      !careerSnapshotBindingMatches({ careerSnapshotId: data.scoringCareerSnapshotId }, careerSnapshotId)
      || data.scoredJobs.some(job => normalizedJobCareerSnapshotId(job?.careerSnapshotId) !== careerSnapshotId)
    ))
    || queries.length === 0
    || !preferredLocation
    || !data.queryCacheKey
    || data.queryCacheKey !== buildJobCareerQueryCacheKey({
      careerSnapshotId,
      resumeFingerprint: data.resumeFingerprint,
      jobPreferences: data.jobPreferences,
      preferredLocation,
    })
    || (String(data.jobPreferences || '').trim() && !preferencePlan)
    || runnableSourceIds.length === 0
    || runnableSourceIds.some(sourceId => !BACKGROUND_SAFE_SOURCE_IDS.has(sourceId))
  ) return null;

  const anchor = jobSearchNextAnchor(data, node.id);
  const initialLookbackDays = normalizeJobSearchInitialLookbackDays(
    data.initialLookbackDays ?? data.maxAgeDays,
  );
  const window = resolveJobSearchDateWindow(anchor.timestamp, clock, initialLookbackDays);
  const searchWindow = {
    startTimestamp: window.startTimestamp,
    anchorTimestamp: window.anchorTimestamp,
    completionTimestamp: window.completionTimestamp,
    capped: window.capped,
    capReason: window.capReason,
    providerLookbackDays: window.providerLookbackDays,
    anchorSource: anchor.source,
  };
  return {
    version: 1,
    inputKey: backgroundBoardChildInputKey(node),
    boardNodeId,
    boardRunId,
    childNodeId: node.id,
    preparedAt: startedAt,
    request: {
      queries,
      nodeId: node.id,
      careerSnapshotId,
      lastCompletedRunAt: anchor.timestamp,
      initialLookbackDays,
      searchWindow,
      collectionLimits,
      enabledSourceIds: runnableSourceIds,
      canvasFilePath,
      preferredLocation,
      rawLocation: String(data.preferredLocation || preferredLocation),
      targetRole: String(data.targetRole || ''),
      jobPreferences: String(data.jobPreferences || ''),
      jobPreferencePlan: preferencePlan,
      countryScope: String(data.canonicalCountry || searchLocation.country || ''),
      profileFingerprint: fingerprint,
      runOrigin: 'job-board-scan',
      profileInputMode: 'stored-profile',
      providerPhaseOnly: true,
    },
  };
}

export function validateBackgroundBoardChildRequest(prepared, node, boardPlan, canvasFilePath) {
  if (
    prepared?.version !== 1
    || !prepared.request
    || prepared.boardRunId !== boardPlan?.boardRunId
    || prepared.childNodeId !== node?.id
    || prepared.request.nodeId !== node?.id
    || prepared.request.careerSnapshotId !== normalizedJobCareerSnapshotId(node?.data?.careerSnapshotId)
    || typeof canvasFilePath !== 'string'
    || !canvasFilePath
    || prepared.inputKey !== backgroundBoardChildInputKey(node)
    || prepared.request.providerPhaseOnly !== true
  ) return null;
  const sources = Array.isArray(prepared.request.enabledSourceIds)
    ? prepared.request.enabledSourceIds
    : [];
  if (sources.length === 0 || sources.some(sourceId => !BACKGROUND_SAFE_SOURCE_IDS.has(sourceId))) return null;
  // Save As moves this exact persisted Board plan with the canvas. Rebind the
  // frozen request to that plan's current canonical owner; Board/run/child and
  // input fingerprints still fence it, and the process lease revalidates the
  // adopted path before any provider side effect.
  return {
    ...prepared,
    request: {
      ...prepared.request,
      canvasFilePath,
    },
  };
}

export const __backgroundSafeJobSourceIdsForTests = BACKGROUND_SAFE_SOURCE_IDS;
