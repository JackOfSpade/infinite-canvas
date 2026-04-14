import React from 'react';
import { JOB_SOURCES } from '../../utils/constants';

export function JobHubDoneState({ 
  resultCount, 
  sourceFilter, 
  toggleSourceFilter, 
  resumeSummary 
}) {
  return (
    <div className="flex flex-col items-center justify-center py-6 px-4">
      <div className="text-emerald-400 text-2xl font-bold">{resultCount || 0}</div>
      <p className="text-white/40 text-xs mt-1">jobs matched</p>
      {sourceFilter && (
        <p className="text-blue-400/70 text-[9px] mt-1 font-medium">
          Filtered: {JOB_SOURCES.find(s => s.id === sourceFilter)?.name || sourceFilter}
          <button
            className="ml-1 text-white/30 hover:text-white/60"
            onClick={() => toggleSourceFilter(sourceFilter)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            ✕
          </button>
        </p>
      )}
      {resumeSummary && (
        <p className="text-white/20 text-[10px] mt-2 text-center">
          {resumeSummary}
        </p>
      )}
    </div>
  );
}
