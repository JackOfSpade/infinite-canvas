// The Board's run progress as one line for the side panel.
export function normalizeProgress(progress, selectedCount) {
  if (!progress) return null;
  if (typeof progress === 'string') return { label: progress, completed: null, total: null };

  const completedValue = progress.completed ?? progress.done ?? progress.current;
  const totalValue = progress.total ?? selectedCount;
  const completed = Number.isFinite(Number(completedValue))
    ? Math.max(0, Math.floor(Number(completedValue)))
    : null;
  const total = Number.isFinite(Number(totalValue)) && Number(totalValue) > 0
    ? Math.max(1, Math.floor(Number(totalValue)))
    : null;
  const currentLabel = progress.currentLabel || progress.moduleLabel || '';
  const label = progress.label
    || (completed != null && total != null
      ? `${completed} of ${total} searches complete${currentLabel ? ` · ${currentLabel}` : ''}`
      : currentLabel || 'Starting or continuing selected sources…');

  return { label, completed, total };
}
