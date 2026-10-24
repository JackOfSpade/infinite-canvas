import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { BRIDGE_PROGRESS_COPY } from '../utils/handoffBridgeCopy';
import { claudeProgressTimeLines, deriveClaudeJobProgress } from '../utils/claudeJobProgress';
import { getClaudeApplicationRun, subscribeClaudeApplicationRuns } from '../utils/claudeApplicationRuns';
import { HEADLINE_CLASS, TONE_CLASS } from '../utils/bridgeProgressStyles';
import { Loader2 } from 'lucide-react';

// One current action, scoped candidate counts, and separately labelled clocks.
export function ClaudeProgress({ run, item }) {
  const jobId = item?.jobId;
  // The dock item's run is a discovery-time snapshot; activity-only updates
  // land in the store, so read the live run from there.
  const liveRun = useSyncExternalStore(
    listener => subscribeClaudeApplicationRuns(() => listener()),
    () => getClaudeApplicationRun(jobId),
    () => getClaudeApplicationRun(jobId),
  );
  const [now, setNow] = useState(() => Date.now());
  const view = deriveClaudeJobProgress({ run: liveRun || run, item });
  const lines = claudeProgressTimeLines(view, now);
  const ticking = view.since !== null || view.startedAt !== null || view.lastHeard !== null;

  // One interval for the timer line, alive only while there is a line to
  // update. It cannot outlive the component.
  useEffect(() => {
    if (!ticking) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  const toneLabel = BRIDGE_PROGRESS_COPY.toneLabel[view.tone];

  return (
    <section
      aria-label="Claude progress"
      data-progress-kind={view.kind}
      className={`min-w-0 rounded-lg border px-3 py-3 text-xs leading-relaxed ${TONE_CLASS[view.tone] || TONE_CLASS.neutral}`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-200/65">{view.contextLabel}</div>

      <div role="status" aria-live="polite" aria-atomic="true" className="mt-2.5">
        <div className={`flex items-center gap-2 text-sm font-semibold ${HEADLINE_CLASS[view.tone] || 'text-white'}`}>
          <Loader2 size={14} className="shrink-0 animate-spin text-violet-300" aria-hidden="true" />
          {toneLabel ? <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-75">{toneLabel}</span> : null}
          {view.headline}
        </div>
        {view.detail && <div className="mt-1 text-white/70">{view.detail}</div>}
        {view.summary && <div className="mt-3 border-t border-white/10 pt-2 text-[11px] tabular-nums text-white/65">{view.summary}</div>}
      </div>

      {(lines.total || lines.elapsed || lines.heard) && (
        <p className="mt-2 text-[11px] text-white/50">
          {[lines.total, lines.elapsed, lines.heard].filter(Boolean).join(' · ')}
        </p>
      )}
    </section>
  );
}

export default ClaudeProgress;
