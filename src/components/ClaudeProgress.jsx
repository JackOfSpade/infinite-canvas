import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { BRIDGE_PROGRESS_COPY } from '../utils/handoffBridgeCopy';
import { claudeProgressTimeLines, deriveClaudeJobProgress } from '../utils/claudeJobProgress';
import { getClaudeApplicationRun, subscribeClaudeApplicationRuns } from '../utils/claudeApplicationRuns';
import { HEADLINE_CLASS, TONE_CLASS } from '../utils/bridgeProgressStyles';
import { BridgeStepList } from './BridgeProgress';

// The same four-step progress section BridgeProgress shows for an application
// ChatGPT answers, for a bundle the local Claude runner is answering. The UI
// must not change just because the backend changed.
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
  const ticking = view.since !== null || view.lastHeard !== null;

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
      {view.steps.length > 0 && <BridgeStepList steps={view.steps} />}

      <div role="status" aria-live="polite" aria-atomic="true" className="mt-2.5">
        <div className={`font-semibold ${HEADLINE_CLASS[view.tone] || 'text-white'}`}>
          {toneLabel ? <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-75">{toneLabel}</span> : null}
          {view.headline}
        </div>
        <div className="mt-1 text-white/70">{view.detail}</div>
      </div>

      {(lines.elapsed || lines.heard) && (
        <p className="mt-2 text-[11px] text-white/50">
          {[lines.elapsed, lines.heard].filter(Boolean).join(' · ')}
        </p>
      )}
    </section>
  );
}

export default ClaudeProgress;
