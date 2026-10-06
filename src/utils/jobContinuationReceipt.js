export const JOB_CONTINUATION_RECEIPTS_FIELD = 'jobContinuationAppliedReceipts';
const MAX_RECEIPTS = 32;

function token(value, max = 300) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= max ? normalized : null;
}

export function normalizeJobContinuationAppliedReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intentId = token(value.intentId, 64);
  const parentRunId = token(value.parentRunId);
  const operation = token(value.operation, 80);
  const resultKey = token(value.resultKey, 64);
  const appliedProcessEpoch = token(value.appliedProcessEpoch, 120);
  const appliedAt = Number.isSafeInteger(value.appliedAt) && value.appliedAt > 0
    ? value.appliedAt
    : null;
  if (
    !intentId
    || !parentRunId
    || !operation
    || !/^[a-f0-9]{64}$/.test(resultKey || '')
    || !appliedProcessEpoch
    || !appliedAt
  ) return null;
  return { intentId, parentRunId, operation, resultKey, appliedProcessEpoch, appliedAt };
}

export function jobContinuationAppliedReceipts(data) {
  return (Array.isArray(data?.[JOB_CONTINUATION_RECEIPTS_FIELD])
    ? data[JOB_CONTINUATION_RECEIPTS_FIELD]
    : [])
    .slice(-MAX_RECEIPTS)
    .map(normalizeJobContinuationAppliedReceipt)
    .filter(Boolean);
}

export function findJobContinuationAppliedReceipt(data, intent) {
  if (!intent?.intentId || !intent?.terminalResultKey) return null;
  return jobContinuationAppliedReceipts(data).find(receipt => (
    receipt.intentId === intent.intentId
    && receipt.parentRunId === intent.parentRunId
    && receipt.operation === intent.operation
    && receipt.resultKey === intent.terminalResultKey
  )) || null;
}

export function jobContinuationAppliedReceipt(intent, checkpoint, now = Date.now()) {
  return normalizeJobContinuationAppliedReceipt({
    intentId: intent?.intentId,
    parentRunId: intent?.parentRunId,
    operation: intent?.operation,
    resultKey: checkpoint?.resultKey || intent?.terminalResultKey,
    appliedProcessEpoch: checkpoint?.processEpoch || intent?.processEpoch,
    appliedAt: now,
  });
}

export function upsertJobContinuationAppliedReceipt(data, receipt) {
  const normalized = normalizeJobContinuationAppliedReceipt(receipt);
  const prior = jobContinuationAppliedReceipts(data);
  if (!normalized) return prior;
  return [
    ...prior.filter(candidate => candidate.intentId !== normalized.intentId),
    normalized,
  ].slice(-MAX_RECEIPTS);
}

