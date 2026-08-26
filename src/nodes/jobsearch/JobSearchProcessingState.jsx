import React from 'react';
import { Loader2, XCircle, Terminal } from 'lucide-react';
import { JOB_SOURCE_BY_ID } from '../../utils/constants';

export function JobSearchProcessingState({
  statusLabel,
  hubState,
  totalSourceJobs,
  scoringProgress,
  resumeSummary,
  activeSourceId,
  onReset,
  chromeLaunchInfo,
  queuedRun,
}) {
  const handleCopy = () => {
    if (chromeLaunchInfo?.terminalCommand) {
      navigator.clipboard.writeText(chromeLaunchInfo.terminalCommand).catch(() => {
        // Clipboard permissions vary by shell/webview; the command remains visible.
      });
    }
  };

  if (chromeLaunchInfo) {
    return (
      <div className="group flex flex-col py-4 px-3 relative gap-2.5">
        {onReset && (
          <button
            onClick={onReset}
            className="absolute top-2 right-2 p-1 text-white/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all rounded"
            title="Cancel/Reset Task"
          >
            <XCircle size={14} />
          </button>
        )}
        <div className="flex items-center gap-1.5 text-amber-400">
          <Terminal size={13} />
          <span className="text-[11px] font-semibold">Open Chrome for Indeed</span>
        </div>
        <p className="text-white/50 text-[10px] leading-snug">
          Paste this in Terminal. A separate Chrome window will open — <strong className="text-white/70">log into Indeed</strong> and we'll connect automatically. Your login is saved for next time.
        </p>
        <div
          className="nodrag bg-black/40 border border-white/10 rounded px-2 py-1.5 cursor-pointer hover:border-amber-400/40 transition-colors group/cmd"
          onClick={handleCopy}
          title="Click to copy"
        >
          <p className="text-[9px] text-white/30 mb-0.5 group-hover/cmd:text-amber-400/60 transition-colors">
            click to copy
          </p>
          <p className="text-[9px] text-white/60 font-mono break-all leading-snug">
            {chromeLaunchInfo.terminalCommand}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-white/25">
          <Loader2 size={10} className="animate-spin shrink-0" />
          <span className="text-[9px]">Waiting for Chrome on port {chromeLaunchInfo.port}…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-center justify-center py-6 px-4 relative">
      {onReset && (
        <button
          onClick={onReset}
          className="absolute top-2 right-2 p-1 text-white/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all rounded"
          title="Cancel/Reset Task"
        >
          <XCircle size={14} />
        </button>
      )}
      <Loader2 size={22} className="animate-spin text-blue-400 mb-2" />
      <p className="text-white/60 text-xs font-medium">
        {hubState === 'searching' && activeSourceId
          ? `Scanning ${JOB_SOURCE_BY_ID[activeSourceId]?.name || activeSourceId}...`
          : statusLabel}
      </p>
      {hubState === 'queued' && (
        <p className="text-blue-400/60 text-[10px] mt-1">
          {(queuedRun?.label || 'Job search')} · Position {queuedRun?.position || 1}
        </p>
      )}
      {hubState === 'searching' && totalSourceJobs > 0 && (
        <p className="text-blue-400/60 text-[10px] mt-1">
          {totalSourceJobs} jobs found so far
        </p>
      )}
      {hubState === 'scoring' && scoringProgress?.total > 0 && (
        <p className="text-blue-400/60 text-[10px] mt-1">
          {scoringProgress.scored} / {scoringProgress.total} scored
          {scoringProgress.batch != null && scoringProgress.batchTotal != null && (
            <> · batch {scoringProgress.batch}/{scoringProgress.batchTotal}</>
          )}
          {scoringProgress.phase === 'running' && scoringProgress.attemptSize != null && (
            <> · scoring {scoringProgress.attemptSize} job{scoringProgress.attemptSize === 1 ? '' : 's'}…</>
          )}
          {scoringProgress.phase === 'splitting' && (
            <> · retrying smaller batch…</>
          )}
          {scoringProgress.phase === 'recovering-missing-rows' && scoringProgress.attemptSize != null && (
            <> · recovering {scoringProgress.attemptSize} unresolved score row{scoringProgress.attemptSize === 1 ? '' : 's'}…</>
          )}
        </p>
      )}
      {resumeSummary && (
        <p className="text-white/25 text-[10px] mt-2 text-center truncate max-w-full">
          {resumeSummary}
        </p>
      )}
    </div>
  );
}
