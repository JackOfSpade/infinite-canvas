import { isCareerCompilerTask } from './careerCompilerTasks.js';

const PHASES = new Set(['reading', 'compiling', 'auditing', 'repairing', 'saving', 'cleaning']);
const keyFor = (nodeId, runId) => JSON.stringify([nodeId, runId]);
const timestamp = value => Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;

const PHASE_COPY = {
  reading: ['Reading career files', 'Reading the source files before compiling career data.'],
  compiling: ['Compiling career pages', 'Organizing career facts and keeping their source references.'],
  auditing: ['Auditing career data', 'Checking compiled facts against the source files. Returned checks can still contain findings.'],
  repairing: ['Repairing career data', 'Resolving findings before another audit round.'],
  saving: ['Saving approved career data', 'The audits passed. Saving and verifying the approved career data.'],
  cleaning: ['Preparing career summary', 'Preparing a readable summary of the approved career data.'],
};

function durationSince(value, now) {
  return timestamp(value) === null ? null : Math.max(0, Math.floor((now - value) / 1000));
}

export function deriveCareerCompilationProgress(progress, now = Date.now()) {
  const phase = PHASES.has(progress?.phase) ? progress.phase : null;
  const [label, detail] = PHASE_COPY[phase] || ['Processing career data', 'Waiting for the next progress update.'];
  const round = count(progress?.round);
  const completed = count(progress?.completed);
  const total = count(progress?.total);
  // These are phase-local measured units. A percentage for an audit round
  // must never imply the entire compiler is almost finished or has passed.
  const unit = { reading: 'files read', compiling: 'pages compiled', auditing: 'audit checks returned' }[phase];
  const hasCounts = Boolean(unit && completed !== null && total !== null && total > 0 && completed <= total);
  return {
    label: `${label}${round && ['auditing', 'repairing'].includes(phase) ? ` · round ${round}` : ''}`,
    detail: phase === 'cleaning' && progress?.cached === true
      ? 'Using previously approved career data for these unchanged files.' : detail,
    countLabel: hasCounts ? `${completed}/${total} ${unit}${phase === 'auditing' ? ' this round' : ''}` : null,
    completed: hasCounts ? completed : null,
    total: hasCounts ? total : null,
    totalElapsed: durationSince(progress?.startedAt, now),
    actionElapsed: durationSince(progress?.phaseStartedAt, now),
  };
}

// The dock observes every run, even while another handoff is selected. Retain
// only bounded progress metadata, never prompts, paths, or career contents.
export function recordCareerCompilationProgress(previous, progress) {
  if (!progress || typeof progress.nodeId !== 'string' || !progress.nodeId
    || typeof progress.manualAiRunId !== 'string' || !progress.manualAiRunId || !PHASES.has(progress.phase)) return previous;
  const next = new Map(previous);
  const key = keyFor(progress.nodeId, progress.manualAiRunId);
  const prior = previous.get(key);
  next.delete(key);
  next.set(key, {
    phase: progress.phase,
    startedAt: timestamp(progress.startedAt) ?? prior?.startedAt ?? null,
    phaseStartedAt: timestamp(progress.phaseStartedAt),
    completed: count(progress.completed),
    total: count(progress.total),
    round: count(progress.round),
    cached: progress.cached === true,
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
