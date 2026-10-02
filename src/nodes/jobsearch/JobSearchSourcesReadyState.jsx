import React from 'react';
import { ShieldAlert, FastForward, Play, Square } from 'lucide-react';

/**
 * JobSearchSourcesReadyState — paused-pipeline UI rendered when the hub's
 * `hubState === 'sources-ready'`. The pipeline reached this after finding
 * one or more block-severity scrape warnings (captcha, login wall, etc.)
 * and is now waiting for the user to either:
 *   - Resolve each blocked source via its source card's Solve / Skip buttons
 *     (auto-resumes once the last warning is dropped; a waiting Job Board then
 *     continues automatically), or
 *   - Click "Score current results" here to skip every remaining block at
 *     once and proceed to scoring with the partial data.
 *
 * Mirrors the SellHub 'comps-ready' decision UX so the spend on AI scoring
 * tokens is gated behind explicit user consent when sources were blocked.
 */
export function JobSearchSourcesReadyState({
  blockedCount,
  jobsAvailable,
  locked = false,
  onScoreCurrent,
  onClearCareerFiles = null,
  solvableCount = 0,
  solveAllRunning = false,
  solveAllProgress = null,
  onSolveAll = null,
  onStopSolveAll = null,
  onRetryRemaining = null,
}) {
  // A Board-owned recovery may leave the Search visible while the Board is
  // settling its durable plan. In that state the Search handler correctly
  // rejects a direct score request, so do not promise an action that cannot
  // run. The exact paused Board continuation still receives its callback and
  // remains able to finish scoring after its source decisions are resolved.
  const canScoreCurrent = !locked
    && jobsAvailable > 0
    && typeof onScoreCurrent === 'function';
  const canSolveAll = !locked && solvableCount > 0 && typeof onSolveAll === 'function';
  const canRetryRemaining = !locked && typeof onRetryRemaining === 'function';

  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1.5">
      <ShieldAlert size={20} className="text-amber-400/80 mb-1" />
      <div className="text-amber-400/90 text-sm font-semibold">
        {`${blockedCount} source${blockedCount === 1 ? '' : 's'} blocked`}
      </div>
      <p className="text-white/50 text-[11px] text-center px-2 leading-snug">
        {jobsAvailable > 0
          ? `${jobsAvailable} job${jobsAvailable === 1 ? '' : 's'} ready to score.`
          : 'No jobs are ready to score yet.'}
      </p>
      <p className="text-white/30 text-[10px] text-center px-2 leading-snug mt-1">
        {canScoreCurrent
          ? 'Resolve or skip each source card to continue. Or score the ready jobs now. Board runs continue automatically.'
          : 'Resolve or skip each source card to continue. Board runs continue automatically.'}
      </p>

      {solveAllRunning ? (
        <>
          <button
            type="button"
            onClick={onStopSolveAll}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag mt-3 w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-full bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80 text-[11px] font-medium transition-colors border border-white/10"
            title="Stop after the blocked search query currently open. Everything already recovered is kept."
          >
            <Square size={10} />
            {solveAllProgress?.stopping ? 'Stopping…' : 'Stop solving'}
          </button>
          <p className="text-white/35 text-[10px] text-center px-2 leading-snug mt-1" role="status" aria-live="polite">
            {solveAllProgress
              ? `Solving ${solveAllProgress.sourceId} — source ${Math.min(solveAllProgress.index + 1, solveAllProgress.total)} of ${solveAllProgress.total}. Stay on the browser window and clear each challenge as it appears.`
              : 'Solving blocked sources…'}
          </p>
        </>
      ) : canSolveAll && (
        <button
          type="button"
          onClick={onSolveAll}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag mt-3 w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-full bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 text-[11px] font-medium transition-colors border border-violet-400/25"
          title="Work through every blocked source, and every blocked search query within each one, in sequence. A browser window opens for each; clear the challenge and it moves on by itself."
        >
          <Play size={11} />
          {`Solve all blocked sources (${solvableCount})`}
        </button>
      )}

      {canRetryRemaining && !solveAllRunning && (
        <button
          type="button"
          onClick={onRetryRemaining}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag mt-2 w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-full bg-blue-500/15 text-blue-200 hover:bg-blue-500/25 text-[11px] font-medium transition-colors border border-blue-400/25"
          title="After signing in, retry only the sources still unfinished in this saved search. Completed and staged work stays intact."
        >
          <Play size={11} />
          Retry remaining sources
        </button>
      )}

      {canScoreCurrent && (
        <button
          onClick={onScoreCurrent}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag mt-3 w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-full bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 text-[11px] font-medium transition-colors border border-amber-500/20"
          title="Skip every remaining blocked source and score the partial results we already have."
        >
          <FastForward size={11} />
          Score current results
        </button>
      )}
      {!locked && onClearCareerFiles && (
        <button
          type="button"
          onClick={onClearCareerFiles}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag mt-1 w-full px-2 py-1.5 rounded-full bg-white/5 text-white/45 hover:bg-white/10 hover:text-white/70 text-[11px] font-medium transition-colors border border-white/10"
          title="Clear career data and remove this paused search."
        >
          Clear career data
        </button>
      )}
    </div>
  );
}
