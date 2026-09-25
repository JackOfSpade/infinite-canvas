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
  activeSourceDetail,
  onReset,
  chromeLaunchInfo,
  queuedRun,
}) {
  const primaryStatus = hubState === 'searching' && activeSourceId
    ? `Scanning ${JOB_SOURCE_BY_ID[activeSourceId]?.name || activeSourceId}...`
    : statusLabel;
  const queuedStatus = hubState === 'queued'
    ? `${queuedRun?.label || 'Job search'} · Position ${queuedRun?.position || 1}`
    : null;
  const collectedStatus = hubState === 'searching' && totalSourceJobs > 0
    ? `${totalSourceJobs} listing${totalSourceJobs === 1 ? '' : 's'} collected so far (before de-duplication)`
    : null;
  const scoringStatus = hubState === 'scoring' && scoringProgress?.total > 0
    ? <>
        {scoringProgress.scored} / {scoringProgress.total} scored
        {scoringProgress.batch != null && scoringProgress.batchTotal != null && (
          <> · batch {scoringProgress.batch}/{scoringProgress.batchTotal}</>
        )}
        {scoringProgress.phase === 'running' && scoringProgress.attemptSize != null && (
          <> · scoring {scoringProgress.attemptSize} job{scoringProgress.attemptSize === 1 ? '' : 's'}…</>
        )}
        {scoringProgress.phase === 'splitting' && <> · retrying smaller batch…</>}
        {scoringProgress.phase === 'recovering-missing-rows' && scoringProgress.attemptSize != null && (
          <> · recovering {scoringProgress.attemptSize} unresolved score row{scoringProgress.attemptSize === 1 ? '' : 's'}…</>
        )}
      </>
    : null;

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
            type="button"
            onClick={onReset}
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute top-2 right-2 p-1 text-white/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all rounded"
            aria-label="Cancel and reset job search"
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
        <button
          type="button"
          className="nodrag bg-black/40 border border-white/10 rounded px-2 py-1.5 cursor-pointer hover:border-amber-400/40 transition-colors group/cmd"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleCopy}
          aria-label="Copy the Chrome launch command"
          title="Copy the Chrome launch command"
        >
          <span className="block text-[9px] text-white/30 mb-0.5 group-hover/cmd:text-amber-400/60 transition-colors">
            Copy command
          </span>
          <span className="block text-[9px] text-white/60 font-mono break-all leading-snug">
            {chromeLaunchInfo.terminalCommand}
          </span>
        </button>
        <div className="flex items-center gap-1.5 text-white/25" role="status" aria-live="polite" aria-atomic="true">
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
          type="button"
          onClick={onReset}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-2 right-2 p-1 text-white/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all rounded"
          aria-label="Cancel and reset job search"
          title="Cancel/Reset Task"
        >
          <XCircle size={14} />
        </button>
      )}
      <div className="flex flex-col items-center">
        <Loader2 size={22} className="animate-spin text-blue-400 mb-2" />
        {/* Only the compact phase/source label is live. Collection counts and
            browser-detail updates can change many times per minute; keeping
            them outside this atomic region prevents a screen reader from
            repeatedly re-announcing the entire progress block. */}
        <p className="text-white/60 text-xs font-medium" role="status" aria-live="polite" aria-atomic="true">
          {primaryStatus}
        </p>
        {queuedStatus && <p className="text-blue-400/60 text-[10px] mt-1">{queuedStatus}</p>}
        {/* Browser description walks can take minutes without increasing the
            collection count, so expose the current step visually without
            competing with the compact live status announcement above. */}
        {hubState === 'searching' && activeSourceDetail && (
          <p className="text-white/35 text-[10px] mt-1 text-center px-2 leading-snug">{activeSourceDetail}</p>
        )}
        {collectedStatus && <p className="text-blue-400/60 text-[10px] mt-1">{collectedStatus}</p>}
        {scoringStatus && <p className="text-blue-400/60 text-[10px] mt-1">{scoringStatus}</p>}
      </div>
      {resumeSummary && (
        <p className="text-white/25 text-[10px] mt-2 text-center truncate max-w-full">{resumeSummary}</p>
      )}
    </div>
  );
}
