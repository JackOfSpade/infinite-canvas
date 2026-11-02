// The runner supplies the current action and host-verified candidate counts.
// No ordered stepper: writing and correction can repeat for every candidate.
import { applicationProgressContext, applicationProgressStageLabel, normalizeApplicationProgress } from './applicationProgress.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const time = value => Number.isFinite(value) && value >= 0 ? value : null;

/** 20s, 4 min, 1 h 5 min. Null for a value that is not a non-negative number. */
export function formatProgressDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export const CLAUDE_PROGRESS_COPY = Object.freeze({
  lastHeard: ago => `Last heard from Claude ${ago}`,
  notHeardYet: 'Waiting for activity from Claude',
  justNow: 'just now',
  ago: duration => `${duration} ago`,
  region: 'Claude progress',
  working: Object.freeze(['Claude is working on this handoff', '']),
  toneLabel: Object.freeze({ neutral: '', working: '', attention: 'Needs attention', problem: 'Problem' }),
});

// Tone styling for the Claude progress section.
export const TONE_CLASS = Object.freeze({
  neutral: 'border-white/10 bg-white/[0.03]',
  working: 'border-violet-400/25 bg-violet-500/10',
  attention: 'border-amber-400/35 bg-amber-500/10',
  problem: 'border-red-400/35 bg-red-500/10',
});
export const HEADLINE_CLASS = Object.freeze({
  neutral: 'text-white',
  working: 'text-white',
  attention: 'text-amber-50',
  problem: 'text-red-100',
});

function deriveInner(input) {
  const run = object(input.run), item = object(input.item);
  const stage = applicationProgressStageLabel(run.stage) ? run.stage : item.stage;
  const label = applicationProgressStageLabel(stage);
  const progress = normalizeApplicationProgress(run.progress) || normalizeApplicationProgress(item.progress);
  const context = applicationProgressContext(progress);
  const waiting = run.activity === 'waiting';
  const checking = stage === 'host-verification';
  const corrections = Array.isArray(item.corrections) ? item.corrections.filter(Boolean).length : 0;
  const correcting = ['verify-correction', 'fit-correction', 'fact-correction'].includes(stage);
  const parallel = Number.isSafeInteger(run.activeCalls) && Number.isSafeInteger(run.waitingCalls)
    && run.activeCalls + run.waitingCalls > 1 ? `${run.activeCalls} tasks running · ${run.waitingCalls} waiting for a slot` : '';
  return {
    kind: waiting ? 'claude-queued' : correcting ? 'claude-fixing' : checking ? 'claude-checking' : 'claude-writing',
    steps: [], tone: 'working', contextLabel: context.label, summary: [context.summary, parallel].filter(Boolean).join(' · '),
    headline: waiting ? 'Waiting for an available Claude slot' : label || 'Preparing application',
    detail: waiting ? (label ? `Next action: ${label.toLowerCase()}.` : '')
      : checking ? 'The app is validating this response before continuing.'
        : correcting && corrections ? `${corrections} ${corrections === 1 ? 'finding' : 'findings'} to address in this candidate.`
          : 'Running on this computer.',
    since: time(run.updatedAt), startedAt: context.startedAt ?? time(run.startedAt),
    lastHeard: checking || waiting ? null : time(run.lastActivityAt),
    action: null, actionLabel: null,
  };
}

export function deriveClaudeJobProgress(input) {
  try { return deriveInner(object(input)); }
  catch { return { kind: 'claude-writing', steps: [], tone: 'working', contextLabel: 'Application generation',
    summary: '', headline: 'Preparing application', detail: '', since: null, startedAt: null, lastHeard: null, action: null, actionLabel: null }; }
}

export function claudeProgressTimeLines(view, now) {
  try {
    const clock = time(now), since = time(view?.since), startedAt = time(view?.startedAt), heard = time(view?.lastHeard);
    const duration = start => clock !== null && start !== null ? formatProgressDuration(Math.max(0, clock - start)) : null;
    let heardLine = null;
    if (heard !== null && clock !== null) {
      const ms = Math.max(0, clock - heard);
      heardLine = CLAUDE_PROGRESS_COPY.lastHeard(ms < 2000 ? CLAUDE_PROGRESS_COPY.justNow : CLAUDE_PROGRESS_COPY.ago(formatProgressDuration(ms)));
    } else if (since !== null && !['claude-checking', 'claude-queued'].includes(view?.kind)) heardLine = CLAUDE_PROGRESS_COPY.notHeardYet;
    return { total: duration(startedAt) ? `Total elapsed: ${duration(startedAt)}` : null,
      elapsed: duration(since) ? `${view?.kind === 'claude-queued' ? 'Waiting' : 'This action'}: ${duration(since)}` : null, heard: heardLine };
  } catch { return { total: null, elapsed: null, heard: null }; }
}
