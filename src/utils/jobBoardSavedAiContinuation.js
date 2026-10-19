// A saved semantic AI handoff needs the person's Continue after restart.
// Match the complete Board/Search ownership proof before offering that action.
export function jobBoardHasSavedAiContinuation({ plan, boardNodeId, node, connected }) {
  if (plan?.phase !== 'searches' || !plan.boardRunId || !connected || node?.type !== 'jobhub') return false;
  const active = new Set([plan.activeSourceId, ...(Array.isArray(plan.activeSourceIds) ? plan.activeSourceIds : [])].filter(Boolean));
  const marker = node.data?.manualAiResume;
  if (!active.has(node.id) || !marker?.runId || marker.retirementPending
    || !(marker.recoveryMode === 'reanalyze-saved-jobs'
      || (typeof marker.task === 'string' && marker.task.startsWith('job-')))
    || marker.orchestratorNodeId !== boardNodeId || marker.boardRunId !== plan.boardRunId) return false;
  if (marker.jobRunId && node.data?.jobRunId && marker.jobRunId !== node.data.jobRunId) return false;
  const expected = plan.activeSourceManualAiRunIds?.[node.id];
  return !expected || expected === marker.runId;
}
