import { useEffect, useState } from 'react';
import { recordCareerCompilationProgress } from '../utils/careerCompilationProgress';

// Live observations stay in renderer memory. Node data holds recovery
// authority, never an old spinner, count, or elapsed clock from a prior run.
export function useCareerCompilationProgress(nodeId, runId) {
  const [observation, setObservation] = useState(null);
  useEffect(() => {
    if (!nodeId || !runId || !window.electronAPI?.onCareerCompileProgress) return undefined;
    return window.electronAPI.onCareerCompileProgress(event => {
      if (event?.nodeId !== nodeId || event?.manualAiRunId !== runId) return;
      const recorded = recordCareerCompilationProgress(new Map(), event);
      const progress = recorded.values().next().value;
      if (progress) setObservation({ nodeId, runId, progress });
    });
  }, [nodeId, runId]);
  // Clear the visible observation synchronously when ownership changes;
  // waiting for an effect would flash the previous run's stage and counts.
  return nodeId && runId && observation?.nodeId === nodeId && observation?.runId === runId
    ? observation.progress : null;
}
