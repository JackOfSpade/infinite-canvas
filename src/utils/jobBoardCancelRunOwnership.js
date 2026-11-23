// Which saved search run may a cancelled Job Board turn remove?
//
// Cancel looks on disk for the hub's unfinished search run. That lookup
// returns ANY unfinished run for the hub, including one left behind by an
// earlier app session. A cancelled turn may remove only the run it started or
// was resuming; an older run must be left exactly as it was.
//
// A turn's operation receipt says which run it belongs to:
//   - a receipt that names a run belongs to that run only (a re-score names
//     the hub's completed run, a resume names the run it resumes);
//   - a fresh search's receipt names no run, and the run it starts records
//     that same operation as its creator.

function receiptRunId(authority) {
  const runId = authority?.semanticBase?.runId;
  return typeof runId === 'string' && runId ? runId : null;
}

/**
 * True when the run found on disk belongs to the cancelled Board turn.
 *
 * @param {object} args
 * @param {string|null} args.runId - run id found on disk
 * @param {string|null} [args.knownRunId] - run id the turn already knew as its own
 * @param {boolean} [args.ownsExistingRecoveryRun] - the turn was resuming a saved run
 * @param {boolean} [args.rescoreOnly] - the turn only re-scores saved jobs and starts no run
 * @param {object|null} [args.authority] - the cancelled turn's operation receipt
 * @param {object|null} [args.manifestAuthority] - the receipt recorded with the run on disk
 */
export function boardCancelOwnsFoundRun({
  runId,
  knownRunId = null,
  ownsExistingRecoveryRun = false,
  rescoreOnly = false,
  authority = null,
  manifestAuthority = null,
} = {}) {
  if (typeof runId !== 'string' || !runId) return false;
  if (ownsExistingRecoveryRun === true) return true;
  if (knownRunId && knownRunId === runId) return true;
  // A re-score of saved jobs never starts a search run, so whatever is on
  // disk was there before it.
  if (rescoreOnly === true) return false;
  // No receipt at all: an interruption from before receipts were recorded.
  // Keep the earlier behaviour (the caller's own prior-run test still applies).
  if (!authority) return true;
  const namedRunId = receiptRunId(authority);
  if (namedRunId) return namedRunId === runId;
  // A fresh search: the run it started records the same operation.
  const turnOperationId = authority.operationId || null;
  const runOperationId = manifestAuthority?.operationId || null;
  if (turnOperationId && runOperationId && turnOperationId !== runOperationId) return false;
  return true;
}

/**
 * True when a saved cancellation record names a run its own receipt cannot
 * belong to. Such a record can never be completed (the app process refuses
 * the removal every time), so the run id in it must be dropped.
 */
export function boardCancelRecordNamesForeignRun(record) {
  if (!record || typeof record.runId !== 'string' || !record.runId) return false;
  if (record.ownsExistingRecoveryRun === true) return false;
  const namedRunId = receiptRunId(record.operationAuthority);
  return !!namedRunId && namedRunId !== record.runId;
}
