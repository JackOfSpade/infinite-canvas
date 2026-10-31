import { isCareerCompilerTask } from './careerCompilerTasks.js';

// Card preparation is routed through its parent hub's AI bridge, but the card
// owns the request. Search-owned official-posting checks reuse the Search run
// id and must continue to participate in normal hub recovery.
export function isCardOfficialPostingRunId(runId) {
  return typeof runId === 'string' && runId.startsWith('official-posting:');
}

// Remove only accidentally adopted card markers. This never retires the
// card's backend run, resets completed Search results, or changes real hub
// checkpoints and cleanup receipts.
export function cardOfficialPostingHubMarkerCleanup(data) {
  if (!data || typeof data !== 'object') return null;
  const patch = {};
  if (isCardOfficialPostingRunId(data.manualAiResume?.runId)) patch.manualAiResume = null;
  if (Array.isArray(data.manualAiCleanupReceipts)) {
    const kept = data.manualAiCleanupReceipts.filter(receipt => !isCardOfficialPostingRunId(receipt?.runId));
    if (kept.length !== data.manualAiCleanupReceipts.length) patch.manualAiCleanupReceipts = kept;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// Only Job Search's own manual-AI runs understand the dock's saved-stop event.
// A Job Search may pause during file extraction or any compiler/audit/repair
// stage, so retain the whole `career-profile-*` family alongside the job-*
// stages. The mounted node re-checks the
// exact run id before it acts; this is merely the dock's narrow UI eligibility
// gate, not an authorization boundary. A card's or Board's official-posting
// lookup is routed through a hub but owned by the card, so no Job Search can
// acknowledge a pause for it.
export const isJobSearchPauseEligible = (request) => (
  request?.kind !== 'application'
  && typeof request?.nodeId === 'string' && request.nodeId.length > 0
  && typeof request?.runId === 'string' && request.runId.length > 0
  && !isCardOfficialPostingRunId(request.runId)
  && (
    isCareerCompilerTask(request.task)
    || (typeof request.task === 'string' && request.task.startsWith('job-'))
  )
);
