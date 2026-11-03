import React, { useSyncExternalStore } from 'react';
import { useProgressClock } from '../hooks/useProgressClock';
import { CLAUDE_PROGRESS_COPY, HEADLINE_CLASS, TONE_CLASS, claudeProgressTimeLines, deriveClaudeJobProgress, deriveClaudeTaskProgress, formatProgressDuration } from '../utils/claudeJobProgress';
import { getClaudeApplicationRun, subscribeClaudeApplicationRuns } from '../utils/claudeApplicationRuns';
import { getClaudeTaskActivity, subscribeClaudeTaskActivity } from '../utils/claudeTaskActivityStore';
import { Loader2 } from 'lucide-react';

const stepAge = (at, now) => {
  if (!Number.isFinite(now)) return '';
  const age = formatProgressDuration(Math.max(0, now - at));
  return age ? `${age} ago` : '';
};

// Every Claude status panel draws through this card. Only the headline and
// detail sit in the live region: the clocks and counts change too often to announce.
export function ClaudeProgressCard({
  kind, tone = 'working', contextLabel, headline, detail, summary, steps = [], timeLines = [], stale = false,
  count = null, headerAction = null, footer = null, now = null, compact = false, region = CLAUDE_PROGRESS_COPY.region, ...sectionProps
}) {
  const toneLabel = CLAUDE_PROGRESS_COPY.toneLabel[tone];
  const hasHeader = contextLabel || headerAction;
  return (
    <section
      {...sectionProps}
      aria-label={region}
      data-progress-kind={kind}
      className={`min-w-0 rounded-lg border leading-relaxed ${compact ? 'px-2 py-2 text-[10px]' : 'px-3 py-3 text-xs'} ${TONE_CLASS[tone] || TONE_CLASS.neutral}`}
    >
      {hasHeader && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-200/65">{contextLabel}</div>
          {headerAction}
        </div>
      )}

      <div role="status" aria-live="polite" aria-atomic="true" className={hasHeader ? 'mt-2.5' : undefined}>
        <div className={`flex items-center gap-2 font-semibold ${compact ? 'text-xs' : 'text-sm'} ${HEADLINE_CLASS[tone] || 'text-white'}`}>
          <Loader2 size={14} className="shrink-0 animate-spin text-violet-300" aria-hidden="true" />
          {toneLabel ? <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-75">{toneLabel}</span> : null}
          <span className="min-w-0">{headline}</span>
        </div>
        {detail && <div className="mt-1 break-words text-white/70">{detail}</div>}
      </div>

      {count && (
        <div className="mt-2 space-y-1.5">
          <p className="tabular-nums text-white/75">{count.label}</p>
          <div role="progressbar" aria-label={`${count.label}; current stage only`} aria-valuemin={0} aria-valuenow={count.completed} aria-valuemax={count.total} className="h-1 w-full overflow-hidden rounded bg-white/10">
            <div className="h-full bg-violet-400 transition-[width]" style={{ width: `${count.completed / count.total * 100}%` }} />
          </div>
        </div>
      )}

      {summary && <div className="mt-3 border-t border-white/10 pt-2 text-[11px] tabular-nums text-white/65">{summary}</div>}

      {steps.length > 0 && (
        <ol aria-label="Recent steps" className="mt-2 space-y-0.5 text-[11px] text-white/55">
          {steps.map((step, index) => (
            <li key={`${step.at}:${index}`} className={`flex items-baseline justify-between gap-3 ${index === steps.length - 1 ? 'text-white/80' : ''}`}>
              <span className="min-w-0 break-words">{step.label}</span>
              <span className="shrink-0 tabular-nums text-white/40">{stepAge(step.at, now)}</span>
            </li>
          ))}
        </ol>
      )}

      {timeLines.length > 0 && (
        <p className={`mt-2 text-[11px] tabular-nums ${stale ? 'font-medium text-amber-200' : 'text-white/50'}`}>
          {timeLines.join(' · ')}
        </p>
      )}
      {footer}
    </section>
  );
}

function presentView(view, now) {
  const lines = claudeProgressTimeLines(view, now);
  return {
    kind: view.kind, tone: view.tone, contextLabel: view.contextLabel, headline: view.headline, detail: view.detail,
    summary: view.summary, steps: view.steps, now, stale: lines.stale,
    timeLines: [lines.next, lines.total, lines.elapsed, lines.heard].filter(Boolean),
  };
}

const hasClock = view => view.since !== null || view.startedAt !== null || view.lastHeard !== null;

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
  const activity = useSyncExternalStore(subscribeClaudeTaskActivity, getClaudeTaskActivity, getClaudeTaskActivity);
  const view = deriveClaudeJobProgress({ run: liveRun || run, item, held: (activity.held || []).includes(`application:${jobId}`), usageLimited: Boolean(activity.usageLimit) });
  const now = useProgressClock(hasClock(view));
  return <ClaudeProgressCard {...presentView(view, now)} />;
}

// A handoff the local Claude worker is answering: its live steps and clocks, no
// controls. Used by the dock for every handoff released to the worker.
export function ClaudeTaskProgress({ requestId, compact = false }) {
  const activity = useSyncExternalStore(subscribeClaudeTaskActivity, getClaudeTaskActivity, getClaudeTaskActivity);
  const view = deriveClaudeTaskProgress({ activity, requestId });
  const now = useProgressClock(hasClock(view));
  return <ClaudeProgressCard {...presentView(view, now)} compact={compact} />;
}

export default ClaudeProgress;
