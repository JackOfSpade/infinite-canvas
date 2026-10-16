import { isCareerCompilerTask } from './careerCompilerTasks.js';

const PHASES = new Set(['reading', 'compiling', 'auditing', 'repairing', 'saving', 'cleaning']);
const keyFor = (nodeId, runId) => JSON.stringify([nodeId, runId]);

// The dock observes every run, even while another handoff is selected. Retain
// only bounded progress metadata, never prompts, paths, or career contents.
export function recordCareerCompilationProgress(previous, progress) {
  if (!progress || typeof progress.nodeId !== 'string' || !progress.nodeId
    || typeof progress.manualAiRunId !== 'string' || !progress.manualAiRunId || !PHASES.has(progress.phase)) return previous;
  const next = new Map(previous);
  const key = keyFor(progress.nodeId, progress.manualAiRunId);
  next.delete(key);
  next.set(key, {
    phase: progress.phase,
    startedAt: Number.isFinite(progress.startedAt) ? progress.startedAt : null,
    completed: Number.isFinite(progress.completed) ? progress.completed : null,
    total: Number.isFinite(progress.total) ? progress.total : null,
    round: Number.isFinite(progress.round) ? progress.round : null,
  });
  while (next.size > 64) next.delete(next.keys().next().value);
  return next;
}

export function careerCompilationProgressForRequest(request, progressByRun) {
  if (!isCareerCompilerTask(request?.task)) return null;
  const exact = progressByRun.get(keyFor(request.nodeId, request.runId));
  if (exact) return exact;
  // Replay/remount can precede the next backend update. The task proves its
  // stage, but supplies no trustworthy phase counts or start time.
  const task = request.task;
  const phase = task.includes('-audit-') ? 'auditing'
    : task.includes('-repair') ? 'repairing'
    : task === 'career-profile-clean' ? 'cleaning'
    : task === 'career-profile-compile' ? 'compiling' : 'reading';
  return { phase };
}
