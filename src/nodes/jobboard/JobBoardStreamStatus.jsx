import React from 'react';

/**
 * What a Job Board is receiving from its connected Job Searches: one read-only
 * line per search, and what the Board has done with the listings so far. The
 * Board shows this; it never starts, pauses or steers a search.
 */
export function JobBoardStreamStatus({ modules = [], summary = null, notice = null, building = false, behind = false, onStopBuilding = null }) {
  if (!Array.isArray(modules) || modules.length === 0) {
    return (
      <p className="px-3 pb-2 text-center text-[10px] leading-snug text-white/35" data-testid="job-board-stream-status">
        Connect a Job Search. Its listings appear here as it reads them.
      </p>
    );
  }
  const count = value => Math.max(0, Math.floor(Number(value) || 0));
  const scored = count(summary?.scored);
  const waiting = count(summary?.waiting);
  const filtered = count(summary?.filtered);
  const unscored = count(summary?.unscored);
  const parts = [
    `${scored} scored`,
    waiting > 0 ? `${waiting} waiting for a description` : '',
    filtered > 0 ? `${filtered} ruled out by preferences` : '',
    unscored > 0 ? `${unscored} not scored yet` : '',
  ].filter(Boolean);
  return (
    <div className="px-3 pb-2 space-y-1" data-testid="job-board-stream-status">
      {modules.map(module => (
        <div key={module.id} className="flex items-baseline justify-between gap-2 text-[10px] leading-snug" title={module.readinessReason || ''}>
          <span className="min-w-0 truncate text-white/60">{module.label}</span>
          <span className={`shrink-0 ${module.streamActive ? 'text-blue-300/80' : 'text-white/35'}`}>{module.statusLabel}</span>
        </div>
      ))}
      <p className="text-[10px] leading-snug text-white/35">{parts.join(' · ')}</p>
      {building && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] leading-snug text-blue-300/70">Adding new listings to the Board…</p>
          {onStopBuilding && (
            <button
              type="button"
              onClick={onStopBuilding}
              className="nodrag shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-white/60 hover:bg-white/10"
              title="Stop adding listings for now. The cards already shown stay."
            >Stop</button>
          )}
        </div>
      )}
      {!building && behind && <p className="text-[10px] leading-snug text-white/35">New listings will be added shortly.</p>}
      {notice && <p className="text-[10px] leading-snug text-amber-300/80" role="status">{notice}</p>}
    </div>
  );
}
