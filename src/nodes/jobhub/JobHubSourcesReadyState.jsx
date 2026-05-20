import React from 'react';
import { ShieldAlert, FastForward } from 'lucide-react';

/**
 * JobHubSourcesReadyState — paused-pipeline UI rendered when the hub's
 * `hubState === 'sources-ready'`. The pipeline reached this after finding
 * one or more block-severity scrape warnings (captcha, login wall, etc.)
 * and is now waiting for the user to either:
 *   - Resolve each blocked source via its source card's Solve / Skip buttons
 *     (auto-resumes once the last warning is dropped), or
 *   - Click "Score current results" here to skip every remaining block at
 *     once and proceed to scoring with the partial data.
 *
 * Mirrors the SellHub 'comps-ready' decision UX so the spend on AI scoring
 * tokens is gated behind explicit user consent when sources were blocked.
 */
export function JobHubSourcesReadyState({
  blockedCount,
  jobsAvailable,
  resumeSummary,
  locked = false,
  onScoreCurrent,
}) {
  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1.5">
      <ShieldAlert size={20} className="text-amber-400/80 mb-1" />
      <div className="text-amber-400/90 text-sm font-semibold">
        {blockedCount} source{blockedCount === 1 ? '' : 's'} blocked
      </div>
      <p className="text-white/50 text-[11px] text-center px-2 leading-snug">
        {jobsAvailable > 0
          ? `${jobsAvailable} job${jobsAvailable === 1 ? ' is' : 's are'} ready to score — but ${blockedCount} source${blockedCount === 1 ? ' needs' : 's need'} attention before we spend AI tokens.`
          : 'Some sources need attention before we score results.'}
      </p>
      <p className="text-white/30 text-[10px] text-center px-2 leading-snug mt-1">
        Solve or skip each blocked card on the canvas — scoring resumes when the last warning clears. Or click below to score what we have now.
      </p>

      {resumeSummary && (
        <p className="text-white/20 text-[10px] text-center mt-1">{resumeSummary}</p>
      )}

      {!locked && jobsAvailable > 0 && (
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
    </div>
  );
}
