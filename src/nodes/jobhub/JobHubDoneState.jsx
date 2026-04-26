import React, { useState } from 'react';
import { JOB_SOURCES } from '../../utils/constants';
import { SlidersHorizontal, X, RefreshCw, Download } from 'lucide-react';
import { EventLogger } from '../../utils/EventLogger';
import { useToast } from '../../components/ToastProvider';

const STATUS_OPTIONS = ['New', 'Applied', 'Interview', 'Offer', 'Rejected'];

export function JobHubDoneState({
  resultCount,
  sourceFilter,
  toggleSourceFilter,
  resumeSummary,
  locked = false,
  // Filter props
  scoreThreshold = 0,
  setScoreThreshold,
  statusFilters = [],
  toggleStatusFilter,
  // Action props
  onRerun,
  jobCards = [],
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exportingCSV, setExportingCSV] = useState(false);
  const { addToast } = useToast();

  const hasActiveFilters = scoreThreshold > 0 || statusFilters.length > 0 || sourceFilter;

  const handleExportCSV = async () => {
    if (exportingCSV || jobCards.length === 0 || !window.electronAPI?.saveFileDialog) return;
    setExportingCSV(true);
    try {
      const esc = (v) => {
        const s = String(v ?? '').replace(/"/g, '""');
        return /[,"\n]/.test(s) ? `"${s}"` : s;
      };
      const header = 'Title,Company,Location,Score,Strength,Status,Source,URL,Notes';
      const rows = jobCards.map(c => [
        esc(c.title), esc(c.company), esc(c.location),
        esc(c.matchScore), esc(c.strengthLabel), esc(c.status || 'New'),
        esc(c.source), esc(c.url), esc(c.notes),
      ].join(','));
      const csv = [header, ...rows].join('\n');
      const result = await window.electronAPI.saveFileDialog({
        defaultFilename: 'job-search-results.csv',
        content: csv,
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      });
      if (result?.saved) {
        addToast({ title: 'CSV Exported', description: `${jobCards.length} jobs saved to ${result.filePath}`, type: 'success' });
      } else if (result?.success === false) {
        EventLogger.error('[JobHub] CSV export write failed:', result.error);
        addToast({ title: 'Export Failed', description: result.error || 'Could not write file', type: 'error' });
      }
      // result.saved === false without success===false means user canceled — no feedback needed
    } catch (e) {
      EventLogger.error('[JobHub] CSV export failed:', e);
    } finally {
      setExportingCSV(false);
    }
  };

  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1">

      {/* Result count */}
      <div className="text-emerald-400 text-2xl font-bold">{resultCount || 0}</div>
      <p className="text-white/40 text-xs">jobs matched</p>

      {/* Active filter summary pills */}
      <div className="flex flex-wrap justify-center gap-1 mt-1 min-h-[18px]">
        {sourceFilter && (
          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400/80 text-[9px]">
            {JOB_SOURCES.find(s => s.id === sourceFilter)?.name || sourceFilter}
            {!locked && (
              <button onClick={() => toggleSourceFilter(sourceFilter)} onPointerDown={(e) => e.stopPropagation()}>
                <X size={8} />
              </button>
            )}
          </span>
        )}
        {scoreThreshold > 0 && (
          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-white/10 text-white/50 text-[9px]">
            ≥{scoreThreshold}%
            {!locked && (
              <button onClick={() => setScoreThreshold?.(0)} onPointerDown={(e) => e.stopPropagation()}>
                <X size={8} />
              </button>
            )}
          </span>
        )}
        {statusFilters.map(s => (
          <span key={s} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-white/10 text-white/50 text-[9px]">
            {s}
            {!locked && (
              <button onClick={() => toggleStatusFilter?.(s)} onPointerDown={(e) => e.stopPropagation()}>
                <X size={8} />
              </button>
            )}
          </span>
        ))}
      </div>

      {resumeSummary && (
        <p className="text-white/20 text-[10px] text-center mt-1">{resumeSummary}</p>
      )}

      {/* Action buttons: re-run + export */}
      {!locked && (
        <div className="flex gap-1.5 mt-2 w-full">
          <button
            onClick={onRerun}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-blue-500/15 text-blue-400/80 hover:bg-blue-500/25 text-[10px] transition-colors border border-blue-500/15"
            title="Clear old cards and re-run the search with the same resume"
          >
            <RefreshCw size={9} />
            Re-run Search
          </button>
          <button
            onClick={handleExportCSV}
            disabled={exportingCSV || jobCards.length === 0}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60 text-[10px] transition-colors disabled:opacity-30 disabled:cursor-default"
            title={jobCards.length === 0 ? 'No cards to export' : `Export ${jobCards.length} jobs as CSV`}
          >
            <Download size={9} />
            {exportingCSV ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      )}

      {/* Filter toggle button */}
      {!locked && (
        <button
          onClick={() => setFiltersOpen(o => !o)}
          onPointerDown={(e) => e.stopPropagation()}
          className={`nodrag mt-2 flex items-center gap-1 px-2 py-1 rounded-full text-[10px] transition-colors ${
            hasActiveFilters
              ? 'bg-blue-500/20 text-blue-400/90 border border-blue-500/20'
              : 'bg-white/5 text-white/35 hover:bg-white/10 hover:text-white/60'
          }`}
        >
          <SlidersHorizontal size={9} />
          {hasActiveFilters ? 'Filters active' : 'Filter cards'}
        </button>
      )}

      {/* Filter panel */}
      {filtersOpen && !locked && (
        <div className="nodrag w-full mt-2 space-y-3 px-1" onPointerDown={(e) => e.stopPropagation()}>

          {/* Score threshold */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-white/40">Min score</span>
              <span className="text-white/60 font-medium">{scoreThreshold > 0 ? `≥${scoreThreshold}%` : 'Any'}</span>
            </div>
            <input
              type="range"
              min={0}
              max={95}
              step={5}
              value={scoreThreshold}
              onChange={(e) => setScoreThreshold?.(Number(e.target.value))}
              className="w-full h-1 accent-blue-400 cursor-pointer"
            />
            <div className="flex justify-between text-[8px] text-white/20">
              <span>0%</span><span>50%</span><span>95%</span>
            </div>
          </div>

          {/* Status filter */}
          <div className="space-y-1">
            <div className="text-white/40 text-[10px]">Show status</div>
            <div className="flex flex-wrap gap-1">
              {STATUS_OPTIONS.map(s => {
                const active = statusFilters.includes(s);
                return (
                  <button
                    key={s}
                    onClick={() => toggleStatusFilter?.(s)}
                    className={`px-1.5 py-0.5 rounded-full text-[9px] transition-colors ${
                      active
                        ? 'bg-blue-500/25 text-blue-400/90 border border-blue-500/20'
                        : 'bg-white/5 text-white/40 hover:bg-white/10'
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
            {statusFilters.length > 0 && (
              <p className="text-white/20 text-[9px]">Showing only selected statuses</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
