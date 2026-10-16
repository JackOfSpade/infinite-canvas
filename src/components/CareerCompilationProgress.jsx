import React, { useEffect, useRef, useState } from 'react';
import { BridgeStepList } from './BridgeProgress';
import { Loader2, PauseCircle } from 'lucide-react';

const PHASES = [
  ['reading', 'Reading career files'],
  ['compiling', 'Compiling career pages'],
  ['auditing', 'Auditing career data'],
  ['saving', 'Saving approved snapshot'],
  ['cleaning', 'Preparing career summary'],
];

export function CareerCompilationProgress({ progress, onPauseAndSave }) {
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
    if (!Number.isFinite(progress?.startedAt)) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress?.startedAt]);
  const phase = progress?.phase || 'reading';
  const repairing = phase === 'repairing';
  const index = repairing ? 2 : Math.max(0, PHASES.findIndex(([key]) => key === phase));
  const label = repairing ? 'Repairing career data' : PHASES[index][1];
  const elapsed = Number.isFinite(progress?.startedAt)
    ? Math.max(0, Math.floor((now - progress.startedAt) / 1000)) : null;
  const hasCounts = Number.isFinite(progress?.completed) && Number.isFinite(progress?.total) && progress.total > 0;
  const completed = hasCounts ? Math.max(0, Math.min(progress.completed, progress.total)) : 0;
  return (
    <section className="min-w-0 space-y-2 rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-3 text-xs text-violet-100/80" aria-label="Career compilation progress" onPointerDown={event => event.stopPropagation()}>
      <div className="flex items-center gap-1.5" role="status" aria-live="polite">
        <Loader2 size={13} className="animate-spin shrink-0 text-blue-300" />
        <span className="flex-1 font-medium">{label}{progress?.round ? ` · round ${progress.round}` : ''}</span>
        {onPauseAndSave && <button type="button" onClick={pause} disabled={pausing} className="inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-1 hover:bg-white/10" aria-label="Pause and save career compilation"><PauseCircle size={12} />{pausing ? 'Saving…' : 'Pause & save'}</button>}
      </div>
      <BridgeStepList steps={PHASES.map(([key], step) => ({ key,
        label: ['Read files', 'Compile', 'Audit', 'Save', 'Summary'][step],
        state: step < index ? 'done' : step === index ? 'current' : 'upcoming',
      }))} />
      <p className="mt-1.5 tabular-nums">Step {index + 1} of {PHASES.length}{hasCounts ? ` · ${completed}/${progress.total} ${phase === 'compiling' ? 'pages compiled' : 'checks returned'}` : ''}{elapsed !== null ? ` · ${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed` : ''}</p>
      {hasCounts && <div role="progressbar" aria-label={phase === 'compiling' ? 'Career pages compiled' : 'Career audit checks returned'} aria-valuemin={0} aria-valuenow={completed} aria-valuemax={progress.total} className="h-1 w-full overflow-hidden rounded bg-white/10">
        <div className="h-full bg-violet-400 transition-[width]" style={{ width: `${completed / progress.total * 100}%` }} />
      </div>}
      {notice && <p role="status" className="text-amber-100">{notice}</p>}
      <p className="mt-1 text-violet-100/50">Each step updates as its AI responses return.</p>
    </section>
  );
}
