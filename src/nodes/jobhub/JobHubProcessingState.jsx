import React from 'react';
import { Loader2 } from 'lucide-react';

export function JobHubProcessingState({ 
  statusLabel, 
  hubState, 
  totalSourceJobs, 
  resumeSummary 
}) {
  return (
    <div className="flex flex-col items-center justify-center py-6 px-4">
      <Loader2 size={22} className="animate-spin text-blue-400 mb-2" />
      <p className="text-white/60 text-xs font-medium">{statusLabel}</p>
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
