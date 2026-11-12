import React, { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, ClipboardCopy, PauseCircle, PlayCircle } from 'lucide-react';
import { ClaudeProgressCard, ClaudeTaskProgress } from './ClaudeProgress';
import { claudeNodePauseKey, getClaudePauseFlow, resumeClaude, startClaudePause, stopRunningClaude, subscribeClaudePauseFlows } from '../utils/claudePauseFlow';
import { getClaudeTaskActivity, subscribeClaudeTaskActivity } from '../utils/claudeTaskActivityStore';
import { getJobRunStatus, getJobRunStatuses, showsOwnPauseButton, subscribeJobRunStatuses } from '../utils/jobRunStatusStore';

const BUTTON = 'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const AMBER = `${BUTTON} border-amber-400/30 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20`;
const NEUTRAL = `${BUTTON} border-white/15 text-white/70 hover:bg-white/10`;

// The one Pause & save control. A held key survives a remount of this button: the
// main process owns the hold, so the state comes back from the activity feed.
export function ClaudePauseControl({ pauseKeys, onSave = null, disabledReason = '' }) {
  const key = pauseKeys[0];
  const flow = useSyncExternalStore(subscribeClaudePauseFlows, () => getClaudePauseFlow(key), () => getClaudePauseFlow(key));
  const activity = useSyncExternalStore(subscribeClaudeTaskActivity, getClaudeTaskActivity, getClaudeTaskActivity);
  const held = (activity.held || []).includes(key);
  const phase = flow.phase !== 'idle' ? flow.phase : held ? 'paused' : 'idle';
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" onPointerDown={event => event.stopPropagation()}>
      {flow.error && <p role="alert" className="min-w-0 flex-1 text-[11px] text-amber-100">{flow.error} Nothing new will start. Retry, or resume.</p>}
      {phase === 'idle' && (
        <button type="button" className={AMBER} disabled={Boolean(disabledReason)} title={disabledReason || 'Start no new Claude calls, let running ones finish and save, then stop.'} onClick={() => { void startClaudePause(pauseKeys, onSave); }}>
          <PauseCircle size={12} aria-hidden="true" />Pause &amp; save
        </button>
      )}
      {phase === 'finishing' && (
        <>
          <span role="status" className="text-[11px] text-amber-100">Finishing running calls, then saving…</span>
          {key.startsWith('node:') && <button type="button" className={NEUTRAL} title="End running calls now. Their answers are lost and they are asked again on resume." onClick={() => stopRunningClaude(pauseKeys)}>Stop now</button>}
        </>
      )}
      {phase === 'saving' && <span role="status" className="text-[11px] text-amber-100">Saving…</span>}
      {phase === 'paused' && (
        <>
          {onSave && flow.error && <button type="button" className={AMBER} onClick={() => { void startClaudePause(pauseKeys, onSave); }}>Retry save</button>}
          <button type="button" className={AMBER} onClick={() => { void resumeClaude(pauseKeys); }}>
            <PlayCircle size={12} aria-hidden="true" />Resume
          </button>
        </>
      )}
    </div>
  );
}

function RunStatusCard({ entry, showPause }) {
  const pauseFooter = showPause ? (
    <div className="mt-2">
      <ClaudePauseControl
        pauseKeys={entry.pauseKeys.length ? entry.pauseKeys : [claudeNodePauseKey(entry.nodeId)]}
        onSave={entry.pauseWithoutSave && !entry.onPause ? null : () => (getJobRunStatus(entry.nodeId)?.onPause || entry.onPause)()}
        disabledReason={entry.pauseDisabledReason}
      />
    </div>
  ) : null;
  // A module with a live Claude request shows the worker's own activity, not a summary.
  if (entry.claudeRequestId) {
    return <ClaudeTaskProgress requestId={entry.claudeRequestId} contextPrefix={entry.label} region={`${entry.label} status`} footer={pauseFooter} />;
  }
  return (
    <ClaudeProgressCard
      kind="job-run"
      region={`${entry.label} status`}
      contextLabel={entry.label}
      headline={entry.headline}
      detail={entry.lines.join(' · ')}
      footer={pauseFooter}
    />
  );
}

/** Every running module's status. pauseOwnedBy names the handoff whose row holds that run's Pause. */
export function JobRunStatusSection({ pauseOwnedBy = null }) {
  const statuses = useSyncExternalStore(subscribeJobRunStatuses, getJobRunStatuses, getJobRunStatuses);
  return statuses.map(entry => <RunStatusCard key={entry.nodeId} entry={entry} showPause={showsOwnPauseButton(entry, pauseOwnedBy, statuses)} />);
}

let minimized = false;

// The panel while modules run with no handoff pending, such as during a scrape.
export function JobRunStatusDock({ yieldsToModal = false }) {
  const statuses = useSyncExternalStore(subscribeJobRunStatuses, getJobRunStatuses, getJobRunStatuses);
  const [isExpanded, setIsExpanded] = useState(!minimized);
  if (!statuses.length) return null;
  const setExpanded = (value) => { minimized = !value; setIsExpanded(value); };
  return createPortal(
    <div className={`pointer-events-none fixed inset-0 ${yieldsToModal ? 'z-[9998]' : 'z-[11000]'}`} role="presentation">
      <div data-run-status-dock={isExpanded ? 'expanded' : 'collapsed'} className={`pointer-events-auto fixed bottom-[5.5rem] right-4 ${yieldsToModal ? 'z-[9999]' : 'z-[11001]'} w-[min(32rem,calc(100vw-2rem))]`}>
        {!isExpanded ? (
          <button type="button" onClick={() => setExpanded(true)} aria-expanded="false" className="ml-auto flex max-w-full items-center gap-2 rounded-xl border border-violet-400/35 bg-neutral-900/95 px-3.5 py-2.5 text-left text-sm text-white shadow-2xl">
            <span className="min-w-0">
              <span className="block font-medium">Modules running</span>
              <span className="block text-xs text-white/55">{statuses.map(entry => entry.label).join(', ')}</span>
            </span>
            <span className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-violet-200">Expand <ChevronUp size={15} aria-hidden="true" /></span>
          </button>
        ) : (
          <section role="region" aria-label="Module status" className="max-h-[calc(100vh-6.5rem)] overflow-hidden rounded-2xl border border-violet-400/25 bg-neutral-900 shadow-2xl flex flex-col">
            <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-5 py-4">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-400/25 bg-violet-500/15"><ClipboardCopy size={16} className="text-violet-300" aria-hidden="true" /></div>
              <h2 className="min-w-0 flex-1 text-sm font-semibold text-white">Modules running</h2>
              <button type="button" onClick={() => setExpanded(false)} className={NEUTRAL}><ChevronDown size={13} aria-hidden="true" />Minimize</button>
            </header>
            <div className="custom-scrollbar flex min-h-0 flex-col gap-3 overflow-y-auto p-5"><JobRunStatusSection /></div>
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}
