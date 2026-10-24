import { assert } from './testHelpers.js';
import { claudeProgressTimeLines, deriveClaudeJobProgress } from '../../src/utils/claudeJobProgress.js';
import { normalizeClaudeRun } from '../../src/utils/claudeApplicationRuns.js';
import { applicationWorkflowProgress } from '../../electron/ipc/applicationWorkflowProgress.js';

const progress = { workflow: 'write-verify', startedAt: 1000, candidate: 2, candidateCount: 5, checked: 1, ready: 0, rejected: 1 };
const run = { status: 'running', stage: 'write', progress, startedAt: 2000, updatedAt: 60000, lastActivityAt: 119000 };
export default [
  { name: 'Claude progress reports the active candidate without inferring completed documents', run() {
    const view = deriveClaudeJobProgress({ run });
    assert(view.headline === 'Write application', 'exact writer action');
    assert(view.contextLabel.includes('Candidate 2 of 5'), 'host candidate ordinal');
    assert(view.summary.includes('1 of 5 checked') && view.summary.includes('1 rejected'), 'counts mean verified outcomes');
    assert(view.steps.length === 0, 'candidate loops have no four-step completion claim');
    assert(!view.headline.includes('Review and edit'), 'writing is shown as writing');
  } },
  { name: 'Claude progress shows planning, corrections, ranking, and host verification distinctly', run() {
    for (const [stage, label] of [['editorial-plan', 'Plan application'], ['convert', 'Structure application'],
      ['verify-correction', 'Correct verification findings'], ['fit-correction', 'Fit documents to one page'],
      ['pick', 'Compare candidates'], ['fact-check', 'Fact-check selected candidate'], ['host-verification', 'Check response']]) {
      const view = deriveClaudeJobProgress({ run: { ...run, stage } });
      assert(view.headline === label && view.steps.length === 0, `truthful action for ${stage}`);
    }
  } },
  { name: 'Claude progress keeps total time across candidate changes and labels each clock', run() {
    const first = claudeProgressTimeLines(deriveClaudeJobProgress({ run }), 121000);
    assert(first.total === 'Total elapsed: 2 min' && first.elapsed === 'This action: 1 min', 'job and action clocks are distinct');
    const next = claudeProgressTimeLines(deriveClaudeJobProgress({ run: { ...run, updatedAt: 120000, progress: { ...progress, candidate: 3 } } }), 121000);
    assert(next.total === first.total && next.elapsed === 'This action: 1s', 'new candidate resets only the action clock');
    assert(first.heard === 'Last heard from Claude 2s ago', 'activity remains independent');
  } },
  { name: 'Claude progress queue and host work never imply provider activity', run() {
    const queued = deriveClaudeJobProgress({ run: { ...run, activity: 'waiting' } });
    assert(queued.kind === 'claude-queued' && queued.headline.includes('available Claude slot'), 'capacity waits are visible');
    const waiting = claudeProgressTimeLines(queued, 121000);
    assert(waiting.elapsed === 'Waiting: 1 min' && waiting.heard === null, 'waiting clock is labelled');
    const checking = deriveClaudeJobProgress({ run: { ...run, stage: 'host-verification' } });
    assert(checking.kind === 'claude-checking' && claudeProgressTimeLines(checking, 121000).heard === null, 'host checks do not claim Claude is streaming');
  } },
  { name: 'Claude progress recovers metadata from a dock snapshot without inventing missing values', run() {
    const view = deriveClaudeJobProgress({ run: { status: 'running', stage: '' }, item: { stage: 'write', progress } });
    assert(view.headline === 'Write application' && view.startedAt === 1000, 'exact fallback metadata');
    const unknown = deriveClaudeJobProgress({ run: { stage: 'unknown', updatedAt: 60000 } });
    assert(unknown.headline === 'Preparing application' && unknown.steps.length === 0 && unknown.summary === '', 'unknown stages stay unknown');
    assert(claudeProgressTimeLines(unknown, 121000).total === null, 'no fabricated total clock');
  } },
  { name: 'Claude progress normalizes only bounded metadata and preserves legitimate zero timestamps', run() {
    const safe = normalizeClaudeRun({ ...run, startedAt: 0, activity: 'waiting' });
    assert(safe.startedAt === 0 && safe.progress.candidate === 2 && safe.activity === 'waiting', 'metadata survives IPC projection');
    const bad = normalizeClaudeRun({ ...run, startedAt: -1, activity: 'secret activity', progress: { ...progress, candidateCount: Infinity } });
    assert(!('startedAt' in bad) && !('progress' in bad) && !('activity' in bad), 'invalid metadata is not exposed');
    const hostile = {}; Object.defineProperty(hostile, 'stage', { get() { throw new Error('synthetic'); } });
    for (const input of [undefined, null, 42, [], { run: hostile }]) assert(deriveClaudeJobProgress(input).steps.length === 0, 'malformed inputs remain neutral');
    for (const clock of [null, undefined, NaN]) assert(claudeProgressTimeLines({}, clock).total === null, 'invalid clocks are omitted');
  } },
  { name: 'Application progress derives candidate outcomes from frozen host state only', run() {
    const input = { createdAt: '2026-01-01T00:00:00Z', candidateCount: 5 };
    const work = { count: 5, ordinal: 1, factIndex: 0, ranking: ['candidate-3'], candidates: [
      { id: 'candidate-1', status: 'dropped' }, { id: 'candidate-2', status: 'correcting' },
      { id: 'candidate-3', status: 'accepted' }, { id: 'candidate-4', status: 'unwritten' }, { id: 'candidate-5', status: 'unwritten' },
    ] };
    const summary = applicationWorkflowProgress(input, { stage: 'write', writeVerify: work });
    assert(summary.candidate === 2 && summary.checked === 2 && summary.ready === 1 && summary.rejected === 1, 'only accepted/dropped candidates count as checked');
    assert(applicationWorkflowProgress(input, { stage: 'pick', writeVerify: work }).candidate === null, 'ranking has no made-up current candidate');
    assert(applicationWorkflowProgress(input, { stage: 'fact-check', writeVerify: work }).candidate === 3, 'fact check names ranked candidate');
    assert(applicationWorkflowProgress(input, { stage: 'requirements' }).checked === 0, 'requirements do not complete candidates');
    assert(applicationWorkflowProgress({}, {}) === null, 'missing frozen count stays unknown');
    assert(!JSON.stringify(summary).includes('candidate-'), 'metadata contains no IDs, facts, or document text');
  } },
];
