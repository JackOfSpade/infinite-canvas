// Keep the Board executor waiting for the same durable acknowledgement as the
// dock. Epoch cancellation during a saved Stop must not enter Board rollback.
export function createDurableBoardPauseControl(owner, plan, nodeId) {
  if (!owner?.orchestratorNodeId || !owner?.boardRunId
    || plan?.boardRunId !== owner.boardRunId
    || !(plan.activeSourceId === nodeId
      || (Array.isArray(plan.activeSourceIds) && plan.activeSourceIds.includes(nodeId)))) return null;
  return { ...owner, pauseOnly: true };
}

export async function pauseBoardOwnedSearch(control, stop) {
  if (!control) return stop();
  if (control.pauseInFlight) return { success: false, error: 'This Job Search is already saving.' };
  control.pauseInFlight = true;
  let acknowledge;
  control.pauseCompletion = new Promise(resolve => { acknowledge = resolve; });
  try {
    const result = await stop();
    const outcome = result?.success === true ? result : {
      success: false, error: result?.error || 'The Job Search pause could not be verified. Its saved work was kept.',
    };
    acknowledge(outcome);
    return outcome;
  } catch (error) {
    const outcome = { success: false, error: error?.message || 'The Job Search pause could not be verified.' };
    acknowledge(outcome);
    return outcome;
  } finally {
    control.pauseInFlight = false;
  }
}

export async function jobBoardSavedPauseOutcome(control, runId) {
  if (!control?.pauseCompletion) return null;
  const result = await control.pauseCompletion;
  return {
    status: result?.success === true ? 'paused' : 'recovery-inspection-failed',
    reason: 'awaiting-explicit-ai-continue',
    runId: runId || control.cancelledRunId || null,
    error: result?.success === true
      ? 'This Job Search is paused with its saved work. Continue from the Job Board when ready.'
      : result?.error || 'The Job Search pause could not be verified. Retry recovery from the Job Board.',
  };
}
