import React, { useEffect, useState } from 'react';
import { BRIDGE_PROGRESS_COPY } from '../utils/handoffBridgeCopy';
import { progressTimeLines } from '../utils/bridgeJobProgress';
import { buildApplicationPageRows, pickWorkerRepresentative } from '../utils/applicationBridgePage';
import { BridgeProgress, BridgeStepList } from './BridgeProgress';
import { HEADLINE_CLASS, TONE_CLASS } from '../utils/bridgeProgressStyles';

// One shared page for every job-application bundle the ChatGPT bridge holds.
// Each bundle keeps its own four-stage progress walk (evidence plan, resume,
// cover letter, review), but worker chats are spawned and monitored exactly
// once for the whole page in a single block underneath the rows — the same
// adaptive worker plan the push-scoring page already uses.

export function BridgeApplicationsPage({
  status,
  held,
  ordinalFor,
  activeRequestId,
  discardingRequestIds,
  discardDisabled,
  onDiscard,
}) {
  const [now, setNow] = useState(() => Date.now());
  const rows = buildApplicationPageRows({ held, status, ordinalFor, now });

  // Tick only while at least one row has a timer line (since/lastHeard).
  // Same shape as BridgeProgress: one shared interval, cleaned on unmount.
  const ticking = rows.some(row => row.view.since !== null || row.view.lastHeard !== null);

  useEffect(() => {
    if (!ticking) return undefined;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (rows.length === 0) return null;

  const representative = pickWorkerRepresentative(rows);
  const discarding = discardingRequestIds instanceof Set ? discardingRequestIds : new Set();

  return (
    <section
      aria-label="Applications handed to ChatGPT"
      data-applications-page="true"
      className="min-w-0 space-y-3"
    >
      <ul className="space-y-2">
        {rows.map(row => {
          const toneClass = TONE_CLASS[row.view.tone] || TONE_CLASS.neutral;
          const headlineClass = HEADLINE_CLASS[row.view.tone] || HEADLINE_CLASS.neutral;
          const lines = progressTimeLines(row.view, now);
          const isActive = row.requestId === activeRequestId;
          const isDiscarding = discarding.has(row.requestId);
          return (
            <li
              key={row.requestId}
              data-application-row={row.requestId}
              aria-current={isActive ? 'true' : undefined}
              className={`rounded-lg border px-3 py-3 text-xs leading-relaxed ${toneClass} ${isActive ? 'ring-1 ring-white/40' : ''}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {row.ordinal !== null && (
                      <span className="text-[11px] font-bold text-white/90">
                        Application {row.ordinal}
                      </span>
                    )}
                    <span
                      className="truncate font-medium text-white/90"
                      title={row.subject}
                    >
                      {row.subject}
                    </span>
                    {row.workerOrdinal !== null && (
                      <span className="text-[11px] text-white/55">
                        Worker {row.workerOrdinal}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isDiscarding || discardDisabled}
                  onClick={() => { if (typeof onDiscard === 'function') onDiscard(row.request); }}
                  title="Delete this application bundle and its private job folder"
                  className="rounded-md border border-red-400/25 px-2.5 py-1.5 text-[11px] font-medium text-red-200/80 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isDiscarding ? 'Discarding…' : 'Discard bundle'}
                </button>
              </div>

              <div className="mt-2.5">
                <BridgeStepList steps={row.view.steps} />
              </div>

              <div role="status" aria-live="polite" aria-atomic="true" className="mt-2.5">
                <div className={`font-semibold ${headlineClass}`}>
                  {BRIDGE_PROGRESS_COPY.toneLabel[row.view.tone] ? (
                    <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-75">
                      {BRIDGE_PROGRESS_COPY.toneLabel[row.view.tone]}
                    </span>
                  ) : null}
                  {row.view.headline}
                </div>
                {row.showDetail && <div className="mt-1 text-white/70">{row.view.detail}</div>}
              </div>

              {(lines.elapsed || lines.heard) && (
                <p className="mt-2 text-[11px] text-white/50">
                  {[lines.elapsed, lines.heard].filter(Boolean).join(' · ')}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {representative && (
        <BridgeProgress
          status={status}
          item={representative.request}
          workersOnly
          observedReleased={rows.length}
        />
      )}
    </section>
  );
}
