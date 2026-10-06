const RECOVERY_VERSION = 1;
export const MARKETPLACE_SOURCE_PLAN_VERSION = 1;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalRecoveryValue(value) {
  if (Array.isArray(value)) return value.map(canonicalRecoveryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalRecoveryValue(value[key])]));
  }
  return value;
}

/** Exact, order-independent fingerprint of a terminal result payload. */
export function marketplaceTerminalResultKey(recovery) {
  if (!recovery || !['analysis-result', 'priced-result', 'status-result'].includes(recovery.phase)) return null;
  const value = recovery.phase === 'status-result'
    ? recovery.completedResults
    : recovery.result;
  if (!value || typeof value !== 'object') return null;
  return JSON.stringify(canonicalRecoveryValue(value));
}

/**
 * Canvas-side proof that this exact sidecar result was applied. The proof is
 * written in the same node-data update as the result fields, but is never sent
 * back into the sidecar. A later launch can therefore acknowledge the replay
 * without confusing a hydration-only marker update with an applied result.
 */
export function markMarketplaceTerminalApplied(recovery, appliedProcessEpoch = null) {
  const resultKey = marketplaceTerminalResultKey(recovery);
  if (!resultKey) return recovery;
  return {
    ...recovery,
    terminalApplied: {
      runId: recovery.runId,
      phase: recovery.phase,
      inputKey: recovery.inputKey,
      updatedAt: recovery.updatedAt,
      resultKey,
      appliedProcessEpoch: cleanText(appliedProcessEpoch),
    },
  };
}

export function marketplaceTerminalReceiptApplied(sidecarRecovery, canvasRecovery) {
  const resultKey = marketplaceTerminalResultKey(sidecarRecovery);
  const proof = canvasRecovery?.terminalApplied;
  return !!resultKey
    && canvasRecovery?.runId === sidecarRecovery?.runId
    && canvasRecovery?.phase === sidecarRecovery?.phase
    && canvasRecovery?.inputKey === sidecarRecovery?.inputKey
    && proof?.runId === sidecarRecovery?.runId
    && proof?.phase === sidecarRecovery?.phase
    && proof?.inputKey === sidecarRecovery?.inputKey
    && proof?.updatedAt === sidecarRecovery?.updatedAt
    && proof?.resultKey === resultKey
    && !!cleanText(proof?.appliedProcessEpoch);
}

function cleanResearchItem(item, index) {
  const productSpec = item?.productSpec && typeof item.productSpec === 'object'
    ? {
      model: cleanText(item.productSpec.model),
      color: cleanText(item.productSpec.color),
      title: cleanText(item.productSpec.title),
    }
    : { model: '', color: '', title: '' };
  return {
    key: cleanText(item?.key) || `item-${index}`,
    label: cleanText(item?.label),
    query: cleanText(item?.query),
    condition: cleanText(item?.condition),
    pricingNotes: cleanText(item?.pricingNotes),
    productSpec,
  };
}

function cleanSourcePlan(sourcePlan = []) {
  const values = Array.isArray(sourcePlan)
    ? sourcePlan
    : (Array.isArray(sourcePlan?.sourceIds) ? sourcePlan.sourceIds : []);
  const seen = new Set();
  const sourceIds = [];
  for (const value of values) {
    const id = cleanText(typeof value === 'string' ? value : value?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sourceIds.push(id);
  }
  return {
    version: MARKETPLACE_SOURCE_PLAN_VERSION,
    contract: 'marketplace-comp-source-v1',
    sourceIds,
  };
}

export function marketplaceResearchInput(items, category = '', sourcePlan = []) {
  return {
    category: cleanText(category),
    items: (Array.isArray(items) ? items : []).map(cleanResearchItem),
    sourcePlan: cleanSourcePlan(sourcePlan),
  };
}

export function marketplaceResearchInputKey(items, category = '', sourcePlan = []) {
  return JSON.stringify(marketplaceResearchInput(items, category, sourcePlan));
}

export function marketplaceResearchIdentityMatches(recovery, items, category = '', sourcePlan = recovery?.input?.sourcePlan) {
  return recovery?.version === RECOVERY_VERSION
    && recovery?.input?.sourcePlan?.version === MARKETPLACE_SOURCE_PLAN_VERSION
    && recovery?.input?.sourcePlan?.contract === 'marketplace-comp-source-v1'
    && recovery.inputKey === marketplaceResearchInputKey(items, category, sourcePlan)
    && JSON.stringify(recovery.input) === JSON.stringify(marketplaceResearchInput(items, category, sourcePlan));
}

export function marketplaceResearchInputMatches(recovery, items, category = '', sourcePlan = recovery?.input?.sourcePlan) {
  return recovery?.phase === 'scrape'
    && marketplaceResearchIdentityMatches(recovery, items, category, sourcePlan);
}

export function marketplaceResolveInput(value = {}) {
  const sourceId = cleanText(value.sourceId);
  const query = typeof value.query === 'string' ? value.query : '';
  const rawItems = value.items;
  if (!sourceId || sourceId.length > 120 || query.length > 2_048) return null;
  if (rawItems !== null && rawItems !== undefined && (!Array.isArray(rawItems) || rawItems.length > 128)) return null;
  const items = Array.isArray(rawItems)
    ? rawItems.map(item => ({
        key: item?.key ?? null,
        query: String(item?.query || ''),
      }))
    : null;
  if (items?.some(item => (
    (item.key !== null && (typeof item.key !== 'string' || item.key.length > 256))
    || item.query.length > 2_048
  ))) return null;
  return {
    sourceId,
    query,
    items,
    noChallengeConfirmed: value.noChallengeConfirmed === true,
  };
}

export function marketplaceResolveInputKey(value = {}) {
  const input = marketplaceResolveInput(value);
  return input ? JSON.stringify(input) : null;
}

export function isAutomaticMarketplaceResolveIntent(recovery) {
  const intent = recovery?.resolveIntent;
  const input = marketplaceResolveInput(intent?.input);
  const pendingQueries = (Array.isArray(recovery?.pendingItems) ? recovery.pendingItems : [])
    .map(item => ({ key: item?.key ?? null, query: String(item?.query || '') }));
  const exactPendingTarget = !!input && (
    Array.isArray(input.items)
      ? JSON.stringify(input.items) === JSON.stringify(pendingQueries)
      : pendingQueries.length === 1 && input.query === pendingQueries[0].query
  );
  return recovery?.phase === 'comps-ready'
    && intent?.status === 'running'
    && !!input
    && intent.inputKey === JSON.stringify(input)
    && JSON.stringify(intent.input) === JSON.stringify(input)
    && recovery.input?.sourcePlan?.sourceIds?.includes(input.sourceId)
    && (recovery.scrapeWarnings || []).some(warning => cleanText(warning?.sourceId) === input.sourceId)
    && exactPendingTarget
    && recovery.manualPause?.status !== 'manual-required';
}

export function marketplacePhotoInputKey(imagePaths, imageIdentities = null) {
  const normalizedPaths = (Array.isArray(imagePaths) ? imagePaths : [])
    .filter(path => typeof path === 'string' && path.trim())
    .map(path => path.trim());
  return Array.isArray(imageIdentities)
    ? JSON.stringify({ imagePaths: normalizedPaths, imageIdentities })
    : JSON.stringify(normalizedPaths);
}

export function marketplacePhotoInputMatches(recovery, imagePaths) {
  const normalizedPaths = (Array.isArray(imagePaths) ? imagePaths : [])
    .filter(path => typeof path === 'string' && path.trim())
    .map(path => path.trim());
  const identities = Array.isArray(recovery?.input?.imageIdentities)
    ? recovery.input.imageIdentities
    : null;
  return recovery?.version === RECOVERY_VERSION
    && recovery?.phase === 'analysis'
    && JSON.stringify(recovery?.input?.imagePaths || normalizedPaths) === JSON.stringify(normalizedPaths)
    && recovery.inputKey === marketplacePhotoInputKey(normalizedPaths, identities);
}

export function marketplaceSynthesisInputKey(items, skippedWarnings = []) {
  return JSON.stringify({
    items: Array.isArray(items) ? items : [],
    skippedWarningSources: (Array.isArray(skippedWarnings) ? skippedWarnings : [])
      .map((warning) => cleanText(warning?.sourceId))
      .filter(Boolean)
      .sort(),
  });
}

export function newMarketplaceRecovery({ runId, phase, input, inputKey, completedSources = {}, pendingItems = null, skippedWarnings = [] }) {
  const resolvedInputKey = phase === 'synthesis' && !inputKey
    ? marketplaceSynthesisInputKey(pendingItems, skippedWarnings)
    : inputKey;
  return {
    version: RECOVERY_VERSION,
    runId: cleanText(runId),
    phase,
    input,
    inputKey: resolvedInputKey,
    completedSources: completedSources && typeof completedSources === 'object' ? completedSources : {},
    pendingItems: Array.isArray(pendingItems) ? pendingItems : null,
    skippedWarnings: Array.isArray(skippedWarnings) ? skippedWarnings : [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function isRestorableMarketplaceRecovery(value) {
  if (!value || value.version !== RECOVERY_VERSION || !cleanText(value.runId)) return false;
  if (value.phase === 'analysis') return typeof value.inputKey === 'string' && Array.isArray(value.input?.imagePaths);
  if (value.phase === 'scrape') return typeof value.inputKey === 'string' && Array.isArray(value.input?.items);
  if (value.phase === 'synthesis') return Array.isArray(value.pendingItems) && value.pendingItems.length > 0;
  if (value.phase === 'analysis-result') return !!value.result?.product;
  if (value.phase === 'comps-ready') {
    const intent = value.resolveIntent;
    const validIntent = intent == null || (
      ['running', 'result'].includes(intent.status)
      && !!marketplaceResolveInput(intent.input)
      && intent.inputKey === marketplaceResolveInputKey(intent.input)
      && (intent.status !== 'result' || (intent.result && typeof intent.result === 'object'))
    );
    return Array.isArray(value.pendingItems) && Array.isArray(value.scrapeWarnings) && validIntent;
  }
  if (value.phase === 'priced-result') return !!value.result && typeof value.result === 'object';
  return false;
}

export function mergeMarketplaceSourceCheckpoint(recovery, payload) {
  if (!isRestorableMarketplaceRecovery(recovery) || recovery.phase !== 'scrape') return recovery;
  if (payload?.runId !== recovery.runId || payload?.inputKey !== recovery.inputKey) return recovery;
  const itemIndex = Number(payload?.itemIndex);
  const sourceId = cleanText(payload?.sourceId);
  if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || itemIndex >= recovery.input.items.length || !sourceId) return recovery;
  if (!payload.record || typeof payload.record !== 'object' || Array.isArray(payload.record)) return recovery;
  const completedSources = { ...(recovery.completedSources || {}) };
  completedSources[itemIndex] = {
    ...(completedSources[itemIndex] || {}),
    [sourceId]: payload.record,
  };
  return { ...recovery, completedSources, updatedAt: Date.now() };
}

export function marketplaceStatusInput(platformIds, watchUrlsByPlatform = {}) {
  const ids = [...new Set((Array.isArray(platformIds) ? platformIds : [])
    .map(cleanText)
    .filter(Boolean))];
  return {
    platformIds: ids,
    watchUrlsByPlatform: Object.fromEntries(ids.map(platformId => [
      platformId,
      (Array.isArray(watchUrlsByPlatform?.[platformId]) ? watchUrlsByPlatform[platformId] : [])
        .map(cleanText)
        .filter(Boolean),
    ])),
  };
}

export function marketplaceStatusInputKey(platformIds, watchUrlsByPlatform = {}) {
  return JSON.stringify(marketplaceStatusInput(platformIds, watchUrlsByPlatform));
}

export function newMarketplaceStatusRecovery({ runId, platformIds, watchUrlsByPlatform }) {
  const input = marketplaceStatusInput(platformIds, watchUrlsByPlatform);
  return {
    version: RECOVERY_VERSION,
    runId: cleanText(runId),
    input,
    inputKey: JSON.stringify(input),
    remainingPlatformIds: input.platformIds.slice(),
    preparedByPlatform: {},
    completedResults: {},
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function isRestorableMarketplaceStatusRecovery(value) {
  const manualPause = value?.manualPause;
  const validManualPause = manualPause == null || (
    ['login-required', 'captcha-required', 'watch-url-required', 'native-read-required'].includes(manualPause.kind)
    && manualPause.status === 'manual-required'
    && Array.isArray(manualPause.platformIds)
    && manualPause.platformIds.length > 0
    && manualPause.platformIds.length <= 32
    && manualPause.platformIds.every(platformId => (
      cleanText(platformId)
      && value?.input?.platformIds?.includes(platformId)
    ))
  );
  return !!value
    && value.version === RECOVERY_VERSION
    && !!cleanText(value.runId)
    && Array.isArray(value.input?.platformIds)
    && typeof value.inputKey === 'string'
    && value.inputKey === JSON.stringify(value.input)
    && Array.isArray(value.remainingPlatformIds)
    && validManualPause
    && (value.remainingPlatformIds.length > 0 || Object.keys(value.completedResults || {}).length > 0);
}

export function mergeMarketplaceStatusPrepared(recovery, payload) {
  if (!isRestorableMarketplaceStatusRecovery(recovery) || payload?.runId !== recovery.runId) return recovery;
  const platformId = cleanText(payload?.platformId);
  if (!recovery.remainingPlatformIds.includes(platformId) || !payload?.prepared) return recovery;
  return {
    ...recovery,
    preparedByPlatform: { ...(recovery.preparedByPlatform || {}), [platformId]: payload.prepared },
    updatedAt: Date.now(),
  };
}

export function completeMarketplaceStatusRecoveryPlatform(recovery, platformId) {
  if (!isRestorableMarketplaceStatusRecovery(recovery)) return recovery;
  const remainingPlatformIds = recovery.remainingPlatformIds.filter(id => id !== platformId);
  const preparedByPlatform = { ...(recovery.preparedByPlatform || {}) };
  delete preparedByPlatform[platformId];
  return { ...recovery, remainingPlatformIds, preparedByPlatform, updatedAt: Date.now() };
}

export function recordMarketplaceStatusResult(recovery, platformId, result, { retryable = false } = {}) {
  if (!isRestorableMarketplaceStatusRecovery(recovery) || !recovery.input.platformIds.includes(platformId)) return recovery;
  const completedResults = { ...(recovery.completedResults || {}), [platformId]: result };
  const remainingPlatformIds = retryable
    ? recovery.remainingPlatformIds
    : recovery.remainingPlatformIds.filter(id => id !== platformId);
  const preparedByPlatform = { ...(recovery.preparedByPlatform || {}) };
  if (!retryable) delete preparedByPlatform[platformId];
  return { ...recovery, completedResults, remainingPlatformIds, preparedByPlatform, updatedAt: Date.now() };
}

export function marketplaceStatusInputMatches(recovery, platformIds, watchUrlsByPlatform = {}) {
  const input = marketplaceStatusInput(platformIds, watchUrlsByPlatform);
  return isRestorableMarketplaceStatusRecovery(recovery)
    && recovery.inputKey === JSON.stringify(input)
    && JSON.stringify(recovery.input) === JSON.stringify(input);
}

export { RECOVERY_VERSION as MARKETPLACE_RECOVERY_VERSION };
