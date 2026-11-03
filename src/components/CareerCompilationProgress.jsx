import React, { useEffect, useRef, useState } from 'react';
import { PauseCircle } from 'lucide-react';
import { ClaudeProgressCard } from './ClaudeProgress';
import { useProgressClock } from '../hooks/useProgressClock';
import { deriveCareerCompilationProgress } from '../utils/careerCompilationProgress';
import { useCareerCompilationProgress } from '../hooks/useCareerCompilationProgress';

const duration = seconds => `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

export function LiveCareerCompilationProgress({ nodeId, runId, onPauseAndSave }) {
  const progress = useCareerCompilationProgress(nodeId, runId);
  return <CareerCompilationProgress progress={progress} onPauseAndSave={onPauseAndSave} compact />;
}

export function CareerCompilationProgress({ progress, onPauseAndSave, compact = false }) {
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
  const now = useProgressClock(Number.isFinite(progress?.startedAt) || Number.isFinite(progress?.phaseStartedAt));
  const view = deriveCareerCompilationProgress(progress, now);
  return (
    <ClaudeProgressCard
      kind="career-compilation"
      region="Career compilation progress"
      compact={compact}
      contextLabel="Career data processing"
      headline={view.label}
      detail={view.detail}
      count={view.countLabel ? { label: view.countLabel, completed: view.completed, total: view.total } : null}
      timeLines={[
        view.totalElapsed !== null ? `Total elapsed: ${duration(view.totalElapsed)}` : null,
        view.actionElapsed !== null ? `This action: ${duration(view.actionElapsed)}` : null,
      ].filter(Boolean)}
      now={now}
      onPointerDown={event => event.stopPropagation()}
      headerAction={onPauseAndSave
        ? <button type="button" onClick={pause} disabled={pausing} className="inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-1 text-violet-100/80 hover:bg-white/10 disabled:opacity-50" aria-label="Pause and save career compilation"><PauseCircle size={12} aria-hidden="true" />{pausing ? 'Saving…' : 'Pause & save'}</button>
        : null}
      footer={notice ? <p role="status" className="mt-2 text-amber-100">{notice}</p> : null}
    />
  );
}
