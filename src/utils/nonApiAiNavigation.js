const hasIdentity = (request) => Boolean(request?.nodeId && request?.runId && request?.task && Number.isFinite(request?.batch));

/**
 * Pick the visible handoff when one request settles. If the selected batch was
 * the newest delivered item, remember its workflow identity so a later batch
 * delivery can take focus ahead of an older correction that is still pending.
 */
export function selectionAfterHandoffSettlement({ queue, settledRequestId, activeRequestId, accepted }) {
  const settledIndex = queue.findIndex(request => request.requestId === settledRequestId);
  const settled = settledIndex >= 0 ? queue[settledIndex] : null;
  if (!settled || activeRequestId !== settledRequestId) {
    return { selectedRequestId: activeRequestId || null, awaitingSuccessor: null, focus: 'preserved' };
  }
  const queuedSuccessor = queue.slice(settledIndex + 1).find(candidate => isWorkflowSuccessor(settled, candidate)) || null;
  if (queuedSuccessor) return { selectedRequestId: queuedSuccessor.requestId, awaitingSuccessor: null, focus: 'queued-successor' };
  const next = queue[settledIndex + 1] || null;
  const previous = queue[settledIndex - 1] || null;
  return {
    // Keep a normal adjacent fallback visible while the preferred workflow
    // successor is still being prepared; it remains reachable either way.
    selectedRequestId: next?.requestId || previous?.requestId || null,
    awaitingSuccessor: accepted === true && hasIdentity(settled)
      ? { requestId: settled.requestId, nodeId: settled.nodeId, runId: settled.runId, task: settled.task, batch: settled.batch }
      : null,
    focus: accepted === true && hasIdentity(settled) ? 'awaiting-successor' : 'cleared',
  };
}

// A settlement from a background handoff must not erase the selected batch's
// remembered continuation while that workflow is still preparing its next UI
// request. Explicit user selection clears this preference in the component.
export function successorPreferenceAfterSettlement({ existing, selection, settledRequestId, activeRequestId }) {
  if (existing && settledRequestId !== existing.requestId) return existing;
  return settledRequestId === activeRequestId ? selection.awaitingSuccessor : existing;
}

export function isWorkflowSuccessor(preference, incoming) {
  if (!preference || !incoming || incoming.requestId === preference.requestId
    || incoming.nodeId !== preference.nodeId || incoming.runId !== preference.runId) return false;
  // A run's next phase changes task and commonly resets its batch number (for
  // example scoring → taxonomy). The earlier phase cannot issue that prompt
  // until its terminal handoff resolves, so it is the successor the person
  // just advanced to. Within one task, require a larger batch to avoid a
  // concurrently delivered sibling or correction stealing focus.
  if (incoming.task !== preference.task) return Boolean(incoming.task);
  return Number.isFinite(incoming.batch) && incoming.batch > preference.batch;
}
