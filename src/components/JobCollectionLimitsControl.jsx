import React, { useId } from 'react';
import { JOB_COLLECTION_LIMITS_MAX, normalizeJobCollectionLimits } from '../utils/jobCollectionLimits';

/** Compact, node-safe controls for the breadth of the next job search. */
export function JobCollectionLimitsControl({ collectionLimits, setCollectionLimits, disabled = false }) {
  const limits = normalizeJobCollectionLimits(collectionLimits);
  const idPrefix = useId();
  const jobsHelpId = `${idPrefix}-jobs-help`;
  const pagesHelpId = `${idPrefix}-pages-help`;
  const change = (key, value) => setCollectionLimits?.({ ...limits, [key]: value });

  return (
    <fieldset
      className="nodrag w-full mt-0.5 rounded border border-white/8 bg-white/[0.025] px-2 py-1.5"
      onPointerDown={(event) => event.stopPropagation()}
      disabled={disabled}
    >
      <legend className="px-1 text-[9px] text-white/30">Search depth</legend>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
        <label className="min-w-0 text-[9px] text-white/40">
          <span className="block truncate">Jobs / platform</span>
          <input
            aria-label="Jobs per platform"
            aria-describedby={jobsHelpId}
            type="number"
            inputMode="numeric"
            data-native-undo="true"
            min={1}
            max={JOB_COLLECTION_LIMITS_MAX.jobsPerPlatform}
            value={limits.jobsPerPlatform ?? ''}
            onChange={(event) => change('jobsPerPlatform', event.target.value)}
            placeholder="All"
            className="mt-0.5 w-full bg-white/5 border border-white/10 rounded text-center text-white/70 text-[10px] py-0.5 outline-none focus:border-blue-400/50 placeholder:text-white/25 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
        <label className="min-w-0 text-[9px] text-white/40">
          <span className="block truncate">Browser pages / search</span>
          <input
            aria-label="Browser pages per search"
            aria-describedby={pagesHelpId}
            type="number"
            inputMode="numeric"
            data-native-undo="true"
            min={1}
            max={JOB_COLLECTION_LIMITS_MAX.pagesPerPlatform}
            value={limits.pagesPerPlatform ?? ''}
            onChange={(event) => change('pagesPerPlatform', event.target.value)}
            placeholder="All"
            className="mt-0.5 w-full bg-white/5 border border-white/10 rounded text-center text-white/70 text-[10px] py-0.5 outline-none focus:border-blue-400/50 placeholder:text-white/25 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
      </div>
      <p id={jobsHelpId} className="mt-1 text-[8px] leading-snug text-white/25">Blank = all in-window matches.</p>
      <p id={pagesHelpId} className="text-[8px] leading-snug text-white/25">Browser boards only. Blank = continue until results end or leave the date window.</p>
    </fieldset>
  );
}
