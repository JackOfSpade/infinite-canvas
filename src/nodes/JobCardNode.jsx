import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { ExternalLink, X, Sparkles } from 'lucide-react';
import { useToast } from '../components/ToastProvider';
import { EventLogger } from '../utils/EventLogger';
import { languageLabel } from '../utils/jobLanguageLabels';
import { NodeHandles } from './_shared/NodeHandles';

// Accent color encodes the match score (interview-likelihood) band, so the
// card's color reinforces the single metric: greener = better odds. Bands match
// the scoring prompt (85+ strong, 65-84 good chance, 40-64 stretch, <40 unlikely).
function scoreColor(score) {
  if (score >= 85) return '#22c55e'; // green  — genuinely strong
  if (score >= 65) return '#3b82f6'; // blue   — good chance of interview
  if (score >= 40) return '#eab308'; // amber  — stretch / longshot
  return '#6b7280';                  // gray   — unlikely
}

/**
 * JobCardNode — a transient, scored job result on the canvas.
 *
 * The workflow is deliberately disposable: search → decide → generate an
 * application (or dismiss the card). There is no status / notes / monitoring CRM
 * here. Whether a job was already *shown* is tracked in a canvas-scoped
 * jobs-history CSV sidecar (written at discovery), so dismissing cards never
 * re-surfaces them on the next search.
 *
 * data shape:
 *   title, company, location, salary, snippet, url, source, posted,
 *   matchScore, reasoning, careerDirection, hubId,
 *   language (optional 2-letter code, set only when non-English → shows a chip)
 */
export function JobCardNode({ id, data }) {
  const { deleteElements, getNode } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const { addToast } = useToast();

  const [showFullReasoning, setShowFullReasoning] = useState(false);
  const [generatingApp, setGeneratingApp] = useState(false);

  // Cache id for closure safety + a mounted flag so async settlements after
  // unmount don't setState.
  const idRef = useRef(id);
  useEffect(() => { idRef.current = id; }, [id]);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const score = data.matchScore || 0;
  const accentColor = scoreColor(score);

  const openJobUrl = useCallback(() => {
    if (data.url && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(data.url);
    }
  }, [data.url]);

  // ── Full application (tailored résumé + cover letter PDFs) ─────────────────
  // Reads the merged career data from the owning hub (not stored per-card, to
  // avoid bloating the canvas file). The backend researches the company, fills
  // the design system, renders both PDFs, then writes them straight into
  //   <canvas dir>/Applied Jobs/<company>/<job title>/
  // and opens that folder in Finder — no save dialog.
  const generateApplication = useCallback(async () => {
    if (!window.electronAPI?.generateApplication) return;
    const careerData = getNode(data.hubId)?.data?.careerData;
    if (!careerData) {
      addToast({
        title: 'No Career Data',
        description: 'Re-run the job search by dropping your career files on the hub, then try again.',
        type: 'error',
      });
      return;
    }
    // Applications are written relative to the saved canvas file, so it must be
    // saved first. Fail loudly rather than dropping PDFs somewhere arbitrary.
    const canvasFilePath = nav?.currentFile || null;
    if (!canvasFilePath) {
      addToast({
        title: 'Save Your Canvas First',
        description: 'Applications are saved next to your canvas in an "Applied Jobs" folder. Save the canvas to a file, then try again.',
        type: 'error',
      });
      return;
    }
    setGeneratingApp(true);
    try {
      addToast({
        title: 'Generating Application',
        description: `Researching ${data.company} and writing your résumé + cover letter…`,
        type: 'info',
      });
      const result = await window.electronAPI.generateApplication({
        nodeId: idRef.current,
        job: {
          title: data.title, company: data.company, snippet: data.snippet,
          location: data.location, salary: data.salary, url: data.url,
        },
        careerData,
      });
      if (!isMountedRef.current) return;
      if (!result.success) {
        addToast({ title: 'Generation Failed', description: result.error, type: 'error' });
        return;
      }
      // Write both PDFs into ./Applied Jobs/<company>/<job>/ next to the canvas,
      // then reveal that folder in Finder. No picker.
      const saved = await window.electronAPI.saveApplication({
        resumePdfPath: result.resumePdfPath,
        coverPdfPath: result.coverPdfPath,
        workDir: result.workDir,
        company: result.company,
        candidateName: result.candidateName,
        jobTitle: data.title,
        canvasFilePath,
      });
      if (!isMountedRef.current) return;
      if (saved?.success && saved.saved) {
        addToast({ title: 'Application Saved', description: `Résumé + cover letter saved to ${saved.dir} — opening in Finder.`, type: 'success' });
      } else if (saved?.success === false) {
        addToast({ title: 'Save Error', description: saved.error || 'Could not save files', type: 'error' });
      }
    } catch (e) {
      if (!isMountedRef.current) return;
      EventLogger.error('Application generation failed:', e);
      addToast({ title: 'Generation Error', description: e?.message || String(e), type: 'error' });
    } finally {
      if (isMountedRef.current) setGeneratingApp(false);
    }
  }, [data.hubId, data.title, data.company, data.snippet, data.location, data.salary, data.url, getNode, nav, addToast]);

  return (
    <div
      className="w-[280px] rounded-2xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden group"
      style={{ borderColor: accentColor + '55' }}
    >
      <NodeHandles className="w-2 h-2" style={{ backgroundColor: accentColor }} />

      {/* Header */}
      <div className="px-3 py-2 flex items-start gap-2 border-b border-white/5">
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

      {/* Source + posted + open listing */}
      <div className="px-3 py-1.5 flex items-center gap-1.5 text-[10px]">
        {data.source && (
          <span className="text-white/30 uppercase tracking-wider">{data.source}</span>
        )}
        {data.language && data.language !== 'en' && (
          <span
            className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300/90 uppercase tracking-wider"
            title={`Listing is in ${languageLabel(data.language)} — kept & scored as-is; applying is your call`}
          >
            {data.language}
          </span>
        )}
        {data.posted && <span className="text-white/20">{data.posted}</span>}
        {data.url && (
          <button
            onClick={(e) => { e.stopPropagation(); openJobUrl(); }}
            className="ml-auto -my-1 p-1 text-white/30 hover:text-white/70 transition-colors"
            title="Open job listing"
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>

      {/* AI match justification — the full text from the scorer is preserved; we
          clamp it so every card keeps a consistent height, and let the user click
          to expand and read it all (then click again to collapse). */}
      {data.reasoning && (
        <div
          className={`px-3 py-1.5 text-white/45 text-xs leading-relaxed border-t border-white/5 cursor-pointer hover:text-white/60 transition-colors ${showFullReasoning ? '' : 'line-clamp-3'}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setShowFullReasoning(v => !v); }}
          title={showFullReasoning ? 'Show less' : 'Show full reasoning'}
        >
          {data.reasoning}
        </div>
      )}

      {/* Generate full application — always visible, tailored résumé + cover letter PDFs */}
      <div className="px-3 py-2 border-t border-white/5" onPointerDown={(e) => e.stopPropagation()}>
        <button
          onClick={data.locked ? undefined : (e) => { e.stopPropagation(); generateApplication(); }}
          disabled={generatingApp || !!data.locked}
          className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-colors ${
            data.locked
              ? 'bg-white/5 text-white/20 cursor-default'
              : 'bg-gradient-to-r from-emerald-500/15 to-blue-500/15 text-emerald-300 hover:from-emerald-500/25 hover:to-blue-500/25 hover:text-emerald-200 disabled:opacity-50'
          }`}
          title="AI researches the company, then writes a tailored résumé + cover letter and saves both as PDFs to your Applied Jobs folder"
        >
          <Sparkles size={13} className={generatingApp ? 'animate-pulse' : ''} />
          {generatingApp ? 'Generating résumé + cover letter…' : 'Generate Résumé + Cover Letter'}
        </button>
      </div>
    </div>
  );
}
