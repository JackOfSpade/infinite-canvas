import React, { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Briefcase, ExternalLink, FileText, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useToast } from '../components/ToastProvider';

const STRENGTH_COLORS = {
  strong: '#22c55e',
  exploring: '#eab308',
  stretch: '#3b82f6',
  unexpected: '#a855f7',
};

const STRENGTH_LABELS = {
  strong: 'Strong Match',
  exploring: 'Worth Exploring',
  stretch: 'Stretch',
  unexpected: 'Unexpected Find',
};

const STATUS_OPTIONS = ['New', 'Applied', 'Interview', 'Offer', 'Rejected'];

/**
 * JobCardNode — displays a scored job result on the canvas.
 *
 * data shape:
 *   title, company, location, salary, snippet, url, source,
 *   matchScore, reasoning, careerDirection, strengthLabel,
 *   status, coverLetter, resumeProfile
 */
export function JobCardNode({ id, data }) {
  const [expanded, setExpanded] = useState(false);
  const [generatingCL, setGeneratingCL] = useState(false);
  const { updateNodeData, deleteElements, getNode } = useReactFlow();
  const { addToast } = useToast();

  const score = data.matchScore || 0;
  const strength = data.strengthLabel || 'exploring';

  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);
  const accentColor = STRENGTH_COLORS[strength] || '#888';
  const status = data.status || 'New';

  const handleStatusChange = (newStatus) => {
    updateNodeData(id, { status: newStatus });
  };

  const generateCoverLetter = async () => {
    if (!window.electronAPI?.generateCoverLetter || !data.resumeProfile) return;
    setGeneratingCL(true);
    try {
      const result = await window.electronAPI.generateCoverLetter({
        profile: data.resumeProfile,
        job: { title: data.title, company: data.company, snippet: data.snippet },
      });
      // Guard: card may have been dismissed while awaiting the IPC response
      if (!getNode(id)) return;
      if (result.success) {
        updateNodeData(id, { coverLetter: result.coverLetter });
        addToast({ title: 'Cover Letter Ready', description: `Generated for ${data.company}`, type: 'success' });
      } else {
        addToast({ title: 'Generation Failed', description: result.error, type: 'error' });
      }
    } catch (e) {
      console.error('Cover letter generation failed:', e);
      addToast({ title: 'Generation Error', description: e?.message || String(e), type: 'error' });
    } finally {
      if (isMountedRef.current) setGeneratingCL(false);
    }
  };

  const openJobUrl = () => {
    if (data.url && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(data.url);
    }
  };

  return (
    <div
      className="bg-[#1a1a1a] border rounded-lg shadow-lg overflow-hidden group"
      style={{ borderColor: accentColor + '40', minWidth: 260, maxWidth: 320 }}
    >
      <Handle type="target" position={Position.Left} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: accentColor }} />

      {/* Header */}
      <div className="px-3 py-2 flex items-start gap-2" style={{ borderBottom: `1px solid ${accentColor}20` }}>
        <div
          className="shrink-0 mt-0.5 w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold"
          style={{ backgroundColor: accentColor + '20', color: accentColor }}
        >
          {score}%
        </div>
        <div className="flex-1 min-w-0 pr-6 relative">
          <div className="text-white/90 text-sm font-semibold leading-tight truncate">{data.title || 'Untitled'}</div>
          <div className="text-white/50 text-xs mt-0.5 truncate">{data.company}{data.location ? ` · ${data.location}` : ''}</div>
          {data.salary && <div className="text-emerald-400/80 text-xs mt-0.5">{data.salary}</div>}
          
          <button 
            onClick={data.locked ? undefined : () => deleteElements({ nodes: [{ id }] })}
            disabled={!!data.locked}
            className={`absolute top-0 -right-2 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-all ${
              data.locked ? 'hidden' : 'text-white/30 hover:text-red-400 hover:bg-white/10'
            }`}
            title="Dismiss Job"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Strength + source badges */}
      <div className="px-3 py-1.5 flex items-center justify-between text-[10px]">
        <span className="px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: accentColor + '20', color: accentColor }}>
          {STRENGTH_LABELS[strength]}
        </span>
        <div className="flex items-center gap-1.5">
          {data.source && (
            <span className="text-white/30 uppercase tracking-wider">{data.source}</span>
          )}
          <span className="text-white/20">{data.posted}</span>
        </div>
      </div>

      {/* Reasoning preview */}
      {data.reasoning && (
        <div className="px-3 py-1.5 text-white/40 text-xs leading-relaxed border-t border-white/5">
          {data.reasoning}
        </div>
      )}

      {/* Status bar */}
      <div className="px-3 py-1.5 flex items-center justify-between border-t border-white/5">
        <select
          value={status}
          onChange={data.locked ? undefined : (e) => handleStatusChange(e.target.value)}
          disabled={!!data.locked}
          className={`bg-transparent text-xs outline-none ${data.locked ? 'text-white/30 cursor-default' : 'text-white/60 cursor-pointer hover:text-white/80'}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {STATUS_OPTIONS.map(s => <option key={s} value={s} className="bg-[#1a1a1a]">{s}</option>)}
        </select>

        <div className="flex items-center gap-1">
          {data.url && (
            <button
              onClick={(e) => { e.stopPropagation(); openJobUrl(); }}
              className="p-1 text-white/30 hover:text-white/70 transition-colors"
              title="Open job listing"
            >
              <ExternalLink size={12} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="p-1 text-white/30 hover:text-white/70 transition-colors"
            title={expanded ? 'Collapse' : 'Expand details'}
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

      {/* Expanded section */}
      {expanded && (
        <div className="px-3 py-2 border-t border-white/5 space-y-2">
          {data.snippet && (
            <div className="text-white/40 text-xs leading-relaxed max-h-24 overflow-y-auto custom-scrollbar">
              {data.snippet}
            </div>
          )}

          {/* Cover Letter */}
          {data.coverLetter ? (
            <div className="space-y-1">
              <div className="text-white/50 text-[10px] font-semibold uppercase tracking-wider">Cover Letter</div>
              <div className="text-white/60 text-xs leading-relaxed max-h-32 overflow-y-auto custom-scrollbar bg-black/20 rounded p-2">
                {data.coverLetter}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(data.coverLetter).catch(err => {
                  console.error('Clipboard write failed:', err);
                  addToast({ title: 'Clipboard Error', description: 'Failed to copy text', type: 'error' });
                })}
                className="text-blue-400/80 text-[10px] hover:text-blue-400 transition-colors"
              >
                Copy to clipboard
              </button>
            </div>
          ) : (
            <button
              onClick={data.locked ? undefined : (e) => { e.stopPropagation(); generateCoverLetter(); }}
              disabled={generatingCL || !!data.locked}
              className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium transition-colors ${
                data.locked
                  ? 'bg-white/5 text-white/20 cursor-default'
                  : 'bg-blue-500/10 text-blue-400/80 hover:bg-blue-500/20 hover:text-blue-400 disabled:opacity-50'
              }`}
            >
              <FileText size={12} />
              {generatingCL ? 'Generating...' : 'Generate Cover Letter'}
            </button>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: accentColor }} />
    </div>
  );
}
