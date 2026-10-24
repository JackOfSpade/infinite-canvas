import React, { useEffect, useRef, useState } from 'react';
import { Loader2, PauseCircle } from 'lucide-react';
import { deriveCareerCompilationProgress } from '../utils/careerCompilationProgress';
import { useCareerCompilationProgress } from '../hooks/useCareerCompilationProgress';

const duration = seconds => `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

export function LiveCareerCompilationProgress({ nodeId, runId, onPauseAndSave }) {
  const progress = useCareerCompilationProgress(nodeId, runId);
  return <CareerCompilationProgress progress={progress} onPauseAndSave={onPauseAndSave} compact />;
}

export function CareerCompilationProgress({ progress, onPauseAndSave, compact = false }) {
  const [now, setNow] = useState(Date.now);
  const [pausing, setPausing] = useState(false);
  const [notice, setNotice] = useState('');
  const pausingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pause = async () => {
    if (pausingRef.current || !onPauseAndSave) return;
    pausingRef.current = true; setPausing(true);
    try {
      const result = await onPauseAndSave();
      if (mounted.current && result?.success === false) setNotice(result.error || 'Could not save this task. Its handoff was kept.');
    } catch {
      if (mounted.current) setNotice('Could not save this task. Its handoff was kept.');
    } finally {
      pausingRef.current = false;
      if (mounted.current) setPausing(false);
    }
  };
  useEffect(() => {
    if (!Number.isFinite(progress?.startedAt) && !Number.isFinite(progress?.phaseStartedAt)) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress?.startedAt, progress?.phaseStartedAt]);
  const view = deriveCareerCompilationProgress(progress, now);
  return (
    <section className={`min-w-0 space-y-2 rounded-lg border border-violet-400/25 bg-violet-500/10 text-violet-100/80 ${compact ? 'px-2 py-2 text-[10px]' : 'px-3 py-3 text-xs'}`} aria-label="Career compilation progress" onPointerDown={event => event.stopPropagation()}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`${compact ? 'text-[9px]' : 'text-[10px]'} font-semibold uppercase tracking-wider text-violet-200/65`}>Career data processing</p>
        {onPauseAndSave && <button type="button" onClick={pause} disabled={pausing} className="inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-1 hover:bg-white/10 disabled:opacity-50" aria-label="Pause and save career compilation"><PauseCircle size={12} aria-hidden="true" />{pausing ? 'Saving…' : 'Pause & save'}</button>}
      </div>
      <div className={`flex items-start gap-2 font-semibold text-violet-50 ${compact ? 'text-xs' : 'text-sm'}`} role="status" aria-live="polite">
        <Loader2 size={15} className="mt-0.5 animate-spin shrink-0 text-violet-200" aria-hidden="true" />
        <span>{view.label}</span>
      </div>
      <p className="leading-relaxed text-violet-100/65">{view.detail}</p>
      {view.countLabel && <div className="space-y-1.5">
        <p className="tabular-nums">{view.countLabel}</p>
        <div role="progressbar" aria-label={`${view.countLabel}; current stage only`} aria-valuemin={0} aria-valuenow={view.completed} aria-valuemax={view.total} className="h-1 w-full overflow-hidden rounded bg-white/10">
          <div className="h-full bg-violet-400 transition-[width]" style={{ width: `${view.completed / view.total * 100}%` }} />
        </div>
      </div>}
      {(view.totalElapsed !== null || view.actionElapsed !== null) && <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-violet-300/10 pt-2 text-[11px] tabular-nums text-violet-100/60">
        {view.totalElapsed !== null && <span>Total elapsed: {duration(view.totalElapsed)}</span>}
        {view.actionElapsed !== null && <span>This action: {duration(view.actionElapsed)}</span>}
      </div>}
      {notice && <p role="status" className="text-amber-100">{notice}</p>}
    </section>
  );
}
