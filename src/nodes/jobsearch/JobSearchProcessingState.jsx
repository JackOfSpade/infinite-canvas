import React from 'react';
import { Loader2, Terminal } from 'lucide-react';
import { JOB_SOURCE_BY_ID } from '../../utils/constants';
import { useCareerCompilationProgress } from '../../hooks/useCareerCompilationProgress';
import { usePublishJobRunStatus } from '../../hooks/usePublishJobRunStatus';
import { deriveCareerCompilationProgress } from '../../utils/careerCompilationProgress';

export function JobSearchProcessingState({
  statusLabel,
  hubState,
  totalSourceJobs,
  scoringProgress,
  activeSourceId,
  activeSourceDetail,
  activeSourceProgress,
  resumeCheckpoint,
  onPauseAndSave,
  chromeLaunchInfo,
  queuedRun,
  onCancelQueued,
  nodeId,
  careerRunId,
  moduleLabel,
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
  const primaryStatus = queuedRun
    ? 'Queued'
    : finishingWithSavedListings
    ? 'Finishing with saved listings…'
    : isDescriptionEnrichment
    ? `Enriching ${activeSourceName} descriptions…`
    : hubState === 'searching' && activeSourceId
    ? `Scanning ${activeSourceName}...`
    : statusLabel;
  const queuedStatus = queuedRun
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
  const checkpointLines = !resumeCheckpoint ? [] : [
    `${finishingWithSavedListings ? 'Finishing with saved checkpoint' : 'Resuming saved checkpoint'} — ${resumeCheckpoint.gatheredCount || 0} listing${resumeCheckpoint.gatheredCount === 1 ? '' : 's'} retained.`,
    !finishingWithSavedListings && isDescriptionEnrichment ? `Source collection is complete; enriching ${activeSourceName} descriptions.` : null,
    !finishingWithSavedListings && !isDescriptionEnrichment && (remainingSources.length > 0 || checkpointDate)
      ? `${remainingSources.length > 0 ? `Continuing ${remainingSources.join(', ')}` : 'Continuing the saved run'}${checkpointDate ? ` · original window starts ${checkpointDate}` : ''}.` : null,
    finishingWithSavedListings ? 'No further sources will be scraped; the next step uses only these retained listings.' : null,
  ];
  const scoringStatus = hubState === 'scoring' && scoringProgress?.total > 0
    ? [
      `${scoringProgress.scored} / ${scoringProgress.total} scored`,
      scoringProgress.batch != null && scoringProgress.batchTotal != null ? `batch ${scoringProgress.batch}/${scoringProgress.batchTotal}` : null,
      scoringProgress.phase === 'running' && scoringProgress.attemptSize != null ? `scoring ${scoringProgress.attemptSize} job${scoringProgress.attemptSize === 1 ? '' : 's'}…` : null,
      scoringProgress.phase === 'splitting' ? 'retrying smaller batch…' : null,
      scoringProgress.phase === 'recovering-missing-rows' && scoringProgress.attemptSize != null ? `recovering ${scoringProgress.attemptSize} unresolved score row${scoringProgress.attemptSize === 1 ? '' : 's'}…` : null,
      scoringProgress.phase === 'gap-review' && scoringProgress.attemptSize != null ? `reviewing the gaps that capped ${scoringProgress.attemptSize} job${scoringProgress.attemptSize === 1 ? '' : 's'} below the bar…` : null,
    ].filter(Boolean).join(' · ')
    : null;

  const careerProgress = useCareerCompilationProgress(nodeId, careerRunId);
  const careerView = hubState === 'parsing' ? deriveCareerCompilationProgress(careerProgress) : null;
  // All status and Pause & save live in the side panel; this node only says it is busy.
  usePublishJobRunStatus(nodeId, {
    label: moduleLabel,
    headline: careerView?.label || primaryStatus,
    lines: careerView ? [careerView.detail, careerView.countLabel] : [
      ...checkpointLines, queuedStatus, descriptionProgress,
      hubState === 'searching' ? activeSourceDetail : null, collectedStatus, scoringStatus,
    ],
    pauseKeys: nodeId ? [`node:${nodeId}`] : [],
    onPause: queuedRun ? null : onPauseAndSave,
  });

  const handleCopy = () => {
    if (chromeLaunchInfo?.terminalCommand) {
      navigator.clipboard.writeText(chromeLaunchInfo.terminalCommand).catch(() => {
        // Clipboard permissions vary by shell/webview; the command remains visible.
      });
    }
  };

  if (chromeLaunchInfo && !queuedRun) {
    return (
      <div className="group flex flex-col py-4 px-3 relative gap-2.5">
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
    <div className="flex flex-col items-center gap-2 px-4 py-4">
      <div className="flex items-center gap-2">
        <Loader2 size={14} className="animate-spin shrink-0 text-blue-400" aria-hidden="true" />
        <p className="text-xs font-medium text-white/70" role="status" aria-live="polite" aria-atomic="true">
          {queuedRun ? `Queued · Position ${queuedRun?.position || 1}` : 'Processing'}
        </p>
      </div>
      {queuedRun && onCancelQueued && <button type="button" onClick={onCancelQueued} onPointerDown={event => event.stopPropagation()} className="nodrag rounded border border-blue-300/25 px-2 py-1 text-[10px] text-blue-100 hover:bg-blue-400/15" aria-label="Cancel queued Job Search">Cancel queued work</button>}
    </div>
  );
}
