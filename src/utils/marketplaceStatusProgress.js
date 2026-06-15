/**
 * Track Marketplace Status scans by request so incremental platform completion
 * cannot clear a spinner owned by another overlapping request.
 */

const ACTIVE_RUNS_BY_NODE = new Map();
const CHECKING_SUBSCRIBERS_BY_NODE = new Map();

export function getMarketplaceStatusActiveRuns(nodeId) {
  if (!ACTIVE_RUNS_BY_NODE.has(nodeId)) ACTIVE_RUNS_BY_NODE.set(nodeId, new Map());
  return ACTIVE_RUNS_BY_NODE.get(nodeId);
}

export function marketplaceStatusCheckingIds(activeRuns) {
  const ids = new Set();
  if (!(activeRuns instanceof Map)) return ids;
  for (const runIds of activeRuns.values()) {
    if (!(runIds instanceof Set)) continue;
    for (const platformId of runIds) ids.add(platformId);
  }
  return ids;
}

export function publishMarketplaceStatusCheckingIds(nodeId) {
  const runs = ACTIVE_RUNS_BY_NODE.get(nodeId);
  const checkingIds = marketplaceStatusCheckingIds(runs);
  for (const listener of CHECKING_SUBSCRIBERS_BY_NODE.get(nodeId) || []) {
    listener(checkingIds);
  }
  if ((!runs || runs.size === 0) && !CHECKING_SUBSCRIBERS_BY_NODE.has(nodeId)) {
    ACTIVE_RUNS_BY_NODE.delete(nodeId);
  }
  return checkingIds;
}

export function subscribeMarketplaceStatusCheckingIds(nodeId, listener) {
  if (typeof listener !== 'function') return () => {};
  let subscribers = CHECKING_SUBSCRIBERS_BY_NODE.get(nodeId);
  if (!subscribers) {
    subscribers = new Set();
    CHECKING_SUBSCRIBERS_BY_NODE.set(nodeId, subscribers);
  }
  subscribers.add(listener);
  listener(marketplaceStatusCheckingIds(getMarketplaceStatusActiveRuns(nodeId)));
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      CHECKING_SUBSCRIBERS_BY_NODE.delete(nodeId);
      if (getMarketplaceStatusActiveRuns(nodeId).size === 0) ACTIVE_RUNS_BY_NODE.delete(nodeId);
    }
  };
}

export function beginMarketplaceStatusRun(activeRuns, runId, platformIds) {
  if (!(activeRuns instanceof Map) || !runId) return marketplaceStatusCheckingIds(activeRuns);
  activeRuns.set(runId, new Set((Array.isArray(platformIds) ? platformIds : []).filter(Boolean)));
  return marketplaceStatusCheckingIds(activeRuns);
}

export function completeMarketplaceStatusPlatform(activeRuns, payload, expectedNodeId) {
  const runId = payload?.runId;
  const platformId = payload?.platformId;
  if (!(activeRuns instanceof Map)
    || payload?.nodeId !== expectedNodeId
    || !runId
    || !platformId
    || !activeRuns.get(runId)?.has(platformId)) {
    return { accepted: false, checkingIds: marketplaceStatusCheckingIds(activeRuns) };
  }

  const ids = activeRuns.get(runId);
  ids.delete(platformId);
  if (ids.size === 0) activeRuns.delete(runId);
  return { accepted: true, checkingIds: marketplaceStatusCheckingIds(activeRuns) };
}

export function finishMarketplaceStatusRun(activeRuns, runId) {
  if (activeRuns instanceof Map) activeRuns.delete(runId);
  return marketplaceStatusCheckingIds(activeRuns);
}

/**
 * Merge completed platform results without allowing an older bulk response to
 * overwrite a newer single-platform recheck.
 */
export function mergeMarketplaceStatusResults(current, incoming) {
  const merged = { ...(current && typeof current === 'object' ? current : {}) };
  if (!incoming || typeof incoming !== 'object') return merged;

  for (const [platformId, result] of Object.entries(incoming)) {
    if (!result || typeof result !== 'object') continue;
    const existing = merged[platformId];
    const existingUpdate = existing?._statusUpdate;
    const incomingUpdate = result._statusUpdate;
    if (existingUpdate?.epoch
      && incomingUpdate?.epoch
      && existingUpdate.epoch === incomingUpdate.epoch
      && Number.isFinite(existingUpdate.sequence)
      && Number.isFinite(incomingUpdate.sequence)) {
      if (incomingUpdate.sequence < existingUpdate.sequence) continue;
      merged[platformId] = result;
      continue;
    }
    const existingTs = existing?.lastChecked ? new Date(existing.lastChecked).getTime() : NaN;
    const incomingTs = result.lastChecked ? new Date(result.lastChecked).getTime() : NaN;
    if (Number.isFinite(existingTs) && (!Number.isFinite(incomingTs) || incomingTs < existingTs)) continue;
    merged[platformId] = result;
  }
  return merged;
}
