import React from 'react';
import { Loader2, PauseCircle, Terminal } from 'lucide-react';
import { JOB_SOURCE_BY_ID } from '../../utils/constants';

export function JobSearchProcessingState({
  statusLabel,
  hubState,
  totalSourceJobs,
  scoringProgress,
  resumeSummary,
  activeSourceId,
  activeSourceDetail,
  activeSourceProgress,
  resumeCheckpoint,
  onPauseAndSave,
  chromeLaunchInfo,
  queuedRun,
}) {
  const finishingWithSavedListings = resumeCheckpoint?.mode === 'finish-with-saved-listings';
  const activeSourceName = JOB_SOURCE_BY_ID[activeSourceId]?.name || activeSourceId;
  const isDescriptionEnrichment = hubState === 'searching'
    && activeSourceProgress?.activity === 'description-enrichment';
  const rawActivityCompleted = Number(activeSourceProgress?.activityCompleted);
  const rawActivityTotal = Number(activeSourceProgress?.activityTotal);
  const hasDescriptionProgress = isDescriptionEnrichment
    && Number.isFinite(rawActivityCompleted)
    && Number.isFinite(rawActivityTotal)
    && rawActivityTotal > 0;
  const descriptionProgress = hasDescriptionProgress
    ? `${Math.max(0, Math.min(rawActivityCompleted, rawActivityTotal))}/${rawActivityTotal} descriptions checked`
    : null;
  const primaryStatus = finishingWithSavedListings
    ? 'Finishing with saved listings…'
    : isDescriptionEnrichment
    ? `Enriching ${activeSourceName} descriptions…`
    : hubState === 'searching' && activeSourceId
    ? `Scanning ${activeSourceName}...`
    : statusLabel;
  const queuedStatus = hubState === 'queued'
    ? `${queuedRun?.label || 'Job search'} · Position ${queuedRun?.position || 1}`
    : null;
  const collectedStatus = hubState === 'searching' && totalSourceJobs > 0
    ? `${totalSourceJobs} listing${totalSourceJobs === 1 ? '' : 's'} currently reported by sources (before de-duplication)`
    : null;
  const checkpointSourceSummary = Array.isArray(resumeCheckpoint?.sourceSummary)
    ? resumeCheckpoint.sourceSummary
    : [];
  const remainingSources = checkpointSourceSummary
    .filter(source => source?.status !== 'done' && source?.status !== 'skipped')
    .map(source => JOB_SOURCE_BY_ID[source?.id]?.name || source?.id)
    .filter(Boolean);
  const checkpointStart = Number(resumeCheckpoint?.searchWindow?.startTimestamp);
  const checkpointDate = Number.isFinite(checkpointStart) && checkpointStart > 0
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(checkpointStart))
    : null;
  const checkpointContext = resumeCheckpoint ? (
    <div className="mt-1 text-center text-[10px] leading-snug text-amber-200/75">
      <p className="font-medium text-amber-200/90">
        {finishingWithSavedListings ? 'Finishing with saved checkpoint' : 'Resuming saved checkpoint'}
        {' — '}{resumeCheckpoint.gatheredCount || 0} listing{resumeCheckpoint.gatheredCount === 1 ? '' : 's'} retained.
      </p>
      {!finishingWithSavedListings && isDescriptionEnrichment && (
        <p className="mt-0.5 text-amber-100/55">
          Source collection is complete; enriching {activeSourceName} descriptions.
        </p>
      )}
      {!finishingWithSavedListings && !isDescriptionEnrichment && (remainingSources.length > 0 || checkpointDate) && (
        <p className="mt-0.5 text-amber-100/55">
          {remainingSources.length > 0
            ? `Continuing ${remainingSources.join(', ')}`
            : 'Continuing the saved run'}
          {checkpointDate ? ` · original window starts ${checkpointDate}` : ''}.
        </p>
      )}
      {finishingWithSavedListings && (
        <p className="mt-0.5 text-amber-100/55">No further sources will be scraped; the next step uses only these retained listings.</p>
      )}
    </div>
  ) : null;
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
        {onPauseAndSave && (
          <button
            type="button"
            onClick={onPauseAndSave}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag absolute top-2 right-2 inline-flex items-center gap-1 rounded border border-amber-300/25 bg-amber-300/10 px-1.5 py-1 text-[9px] font-medium text-amber-100/85 transition-colors hover:border-amber-300/50 hover:bg-amber-300/20 hover:text-amber-50"
            aria-label="Pause and save job search progress for Resume"
            title="Pause and save — resume this Job Search later"
            data-action="pause-and-save"
          >
            <PauseCircle size={12} />
            <span>Pause &amp; save</span>
          </button>
        )}
        <div className="flex items-center gap-1.5 text-amber-400">
          <Terminal size={13} />
          <span className="text-[11px] font-semibold">Open Chrome for Indeed</span>
        </div>
        {checkpointContext}
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
      {onPauseAndSave && (
        <button
          type="button"
          onClick={onPauseAndSave}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag absolute top-2 right-2 inline-flex items-center gap-1 rounded border border-amber-300/25 bg-amber-300/10 px-1.5 py-1 text-[9px] font-medium text-amber-100/85 transition-colors hover:border-amber-300/50 hover:bg-amber-300/20 hover:text-amber-50"
          aria-label="Pause and save job search progress for Resume"
          title="Pause and save — resume this Job Search later"
          data-action="pause-and-save"
        >
          <PauseCircle size={12} />
          <span>Pause &amp; save</span>
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
        {checkpointContext}
        {queuedStatus && <p className="text-blue-400/60 text-[10px] mt-1">{queuedStatus}</p>}
        {descriptionProgress && (
          <p className="text-blue-300/65 text-[10px] mt-1 tabular-nums">{descriptionProgress}</p>
        )}
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
