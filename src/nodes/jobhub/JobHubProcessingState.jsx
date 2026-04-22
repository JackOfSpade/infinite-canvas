import React from 'react';
import { Loader2, XCircle } from 'lucide-react';

export function JobHubProcessingState({ 
  statusLabel, 
  hubState, 
  totalSourceJobs, 
  resumeSummary,
  activeSourceId,
  onReset
}) {
  const sourceNames = {
    google: 'Google', indeed: 'Indeed', linkedin: 'LinkedIn', 
    remoteok: 'RemoteOK', weworkremotely: 'WWR',
    ziprecruiter: 'ZipRecruiter', glassdoor: 'Glassdoor', 
    dice: 'Dice', wellfound: 'Wellfound',
    greenhouse: 'Greenhouse', lever: 'Lever', usajobs: 'USAJobs'
  };

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
        {hubState === 'searching' && activeSourceId ? `Scanning ${sourceNames[activeSourceId] || activeSourceId}...` : statusLabel}
      </p>
      {hubState === 'searching' && totalSourceJobs > 0 && (
        <p className="text-blue-400/60 text-[10px] mt-1">
          {totalSourceJobs} jobs found so far
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
