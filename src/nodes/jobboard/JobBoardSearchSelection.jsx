import React, { useId, useMemo } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Search, X } from 'lucide-react';

const ACTIVE_STATES = new Set([
  'queued',
  'parsing',
  'interpreting-preferences',
  'querying',
  'searching',
  'evaluating-preferences',
  'scoring',
  'scoring-batch',
]);

function moduleReadiness(module) {
  if (module?.ready === false || module?.canRun === false || module?.runnable === false) {
    return {
      ready: false,
      label: module.readinessLabel || module.statusLabel || 'Needs setup',
      reason: module.readinessReason || module.disabledReason || module.reason || '',
    };
  }

  const state = module?.hubState || module?.status || '';
  if (module?.running || ACTIVE_STATES.has(state)) {
    return { ready: true, active: true, label: module.statusLabel || 'Searching…', reason: '' };
  }
  if (state === 'sources-ready') {
    return {
      ready: false,
      label: module.statusLabel || 'Needs attention',
      reason: module.readinessReason || module.reason || 'Resolve or skip the blocked source before continuing.',
    };
  }
  if (state === 'done') {
    const count = Number.isFinite(module?.count)
      ? module.count
      : Number.isFinite(module?.resultCount) ? module.resultCount : null;
    return {
      ready: true,
      label: module.statusLabel || (count == null ? 'Ready to search' : `${count} saved job${count === 1 ? '' : 's'}`),
      reason: '',
    };
  }

  return {
    ready: true,
    label: module?.statusLabel || module?.readinessLabel || 'Ready to search',
    reason: module?.readinessReason || '',
  };
}

function normalizeProgress(progress, selectedCount) {
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
      : currentLabel || 'Searching selected modules…');

  return { label, completed, total };
}

function displayModuleLabel(module) {
  if (typeof module?.label !== 'string') return 'Job Search';
  return module.label.trim().replace(/\s+/g, ' ') || 'Job Search';
}

function labelCollisionKey(label) {
  return label.toLocaleLowerCase();
}

function shortestUniqueIdSuffix(id, peerIds) {
  const minimumLength = Math.min(6, id.length);
  for (let length = minimumLength; length <= id.length; length += 1) {
    const suffix = id.slice(-length);
    if (peerIds.every(peerId => peerId === id || peerId.slice(-length) !== suffix)) {
      return suffix;
    }
  }
  return id;
}

/**
 * Controlled selection and launch UI for a Job Board's connected Job Search
 * modules. Selection is deliberately owned by the caller so rerenders,
 * connection updates, and completed runs never reset the user's choices.
 *
 * Module rows accept `{ id, label, hubState, count, ready, readinessReason }`.
 * `statusLabel`, `canRun`, and `runnable` are supported aliases for callers that
 * already computed a more specific readiness verdict.
 */
export function JobBoardSearchSelection({
  modules = [],
  selectedIds = [],
  onToggle,
  disabled = false,
  running = false,
  progress = null,
  onRun,
  onCancel = null,
  recoveryError = null,
  onRetry = null,
  recoveryCanCancel = true,
}) {
  const fieldsetId = useId();
  const selectedSet = useMemo(
    () => selectedIds instanceof Set ? selectedIds : new Set(Array.isArray(selectedIds) ? selectedIds : []),
    [selectedIds],
  );
  const rows = useMemo(() => {
    const baseRows = (Array.isArray(modules) ? modules : [])
      .filter(module => typeof module?.id === 'string' && module.id)
      .map(module => ({
        module,
        label: displayModuleLabel(module),
        readiness: moduleReadiness(module),
      }));
    const idsByLabel = new Map();
    for (const row of baseRows) {
      const key = labelCollisionKey(row.label);
      const ids = idsByLabel.get(key) || new Set();
      ids.add(row.module.id);
      idsByLabel.set(key, ids);
    }

    return baseRows.map((row) => {
      const peerIds = [...(idsByLabel.get(labelCollisionKey(row.label)) || [])];
      if (peerIds.length < 2) return { ...row, discriminator: null };
      const suffix = shortestUniqueIdSuffix(row.module.id, peerIds);
      return {
        ...row,
        discriminator: {
          suffix,
          visible: `#${suffix}`,
          accessibleName: `Scan ${row.label}, Job Search ${suffix}`,
        },
      };
    });
  }, [modules]);
  const selectedRows = rows.filter(({ module }) => selectedSet.has(module.id));
  const hasUnreadySelection = selectedRows.some(({ readiness }) => !readiness.ready);
  const controlsDisabled = disabled || running || !!recoveryError;
  const canRun = !controlsDisabled
    && typeof onRun === 'function'
    && selectedRows.length > 0
    && !hasUnreadySelection;
  const canCancel = running && recoveryCanCancel && typeof onCancel === 'function';
  const canRetry = !!recoveryError && !disabled && typeof onRetry === 'function';
  const progressState = normalizeProgress(progress, selectedRows.length);

  return (
    <fieldset
      className="nodrag w-full space-y-2"
      onPointerDown={(event) => event.stopPropagation()}
      aria-busy={running}
    >
      <legend className="flex w-full items-center justify-between gap-2 px-0.5 text-[9px] uppercase tracking-wider text-white/35">
        <span>Job searches to scan</span>
        {rows.length > 0 && (
          <span className="normal-case tracking-normal text-white/25">
            {selectedRows.length}/{rows.length} selected
          </span>
        )}
      </legend>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-white/10 px-2 py-3 text-center text-[10px] leading-snug text-white/30">
          Connect one or more Job Search modules to choose what this board scans.
        </div>
      ) : (
        <div className="max-h-44 space-y-1 overflow-y-auto" role="group" aria-label="Connected Job Search modules">
          {rows.map(({ module, label, readiness, discriminator }, index) => {
            const checked = selectedSet.has(module.id);
            const rowDisabled = controlsDisabled || module.disabled === true || module.selectable === false;
            const descriptionId = readiness.reason ? `${fieldsetId}-module-${index}-reason` : undefined;
            const StatusIcon = readiness.active
              ? Loader2
              : readiness.ready ? CheckCircle2 : AlertCircle;
            return (
              <label
                key={module.id}
                className={`flex items-start gap-2 rounded-md border px-2 py-1.5 transition-colors ${
                  checked
                    ? 'border-indigo-500/25 bg-indigo-500/10'
                    : 'border-white/5 bg-white/[0.03] hover:bg-white/5'
                } ${rowDisabled ? 'cursor-default opacity-55' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={rowDisabled}
                  aria-label={discriminator?.accessibleName || `Scan ${label}`}
                  aria-describedby={descriptionId}
                  onChange={(event) => onToggle?.(module.id, event.target.checked)}
                  className="mt-0.5 h-3 w-3 shrink-0 cursor-pointer accent-indigo-400 disabled:cursor-default"
                />
                <span className="min-w-0 flex-1">
                  <span
                    className="flex min-w-0 items-baseline gap-1 text-[10px] font-medium text-white/65"
                    title={discriminator ? `${label} · Job Search ${module.id}` : label}
                  >
                    <span className="min-w-0 truncate">{label}</span>
                    {discriminator && (
                      <span className="shrink-0 font-mono text-[8px] text-white/35" aria-hidden="true">
                        {discriminator.visible}
                      </span>
                    )}
                  </span>
                  {readiness.reason && (
                    <span id={descriptionId} className="mt-0.5 block text-[9px] leading-snug text-amber-300/65">
                      {readiness.reason}
                    </span>
                  )}
                </span>
                <span className={`flex shrink-0 items-center gap-1 text-[9px] ${
                  readiness.ready ? 'text-emerald-300/65' : 'text-amber-300/75'
                }`}>
                  <StatusIcon size={9} className={readiness.active ? 'animate-spin' : ''} aria-hidden="true" />
                  {readiness.label}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {running && progressState && (
        <div className="space-y-1" role="status" aria-live="polite">
          <div className="text-center text-[9px] leading-snug text-indigo-200/65">
            {progressState.label}
          </div>
          {progressState.completed != null && progressState.total != null && (
            <progress
              className="block h-1 w-full overflow-hidden rounded-full accent-indigo-400"
              max={progressState.total}
              value={Math.min(progressState.completed, progressState.total)}
              aria-label="Job search progress"
            />
          )}
        </div>
      )}

      {recoveryError && (
        <p className="text-center text-[9px] leading-snug text-amber-300/70" role="alert">
          {recoveryError}
        </p>
      )}

      {!running && selectedRows.length === 0 && rows.length > 0 && (
        <p className="text-center text-[9px] leading-snug text-amber-300/65" role="status">
          Select at least one connected search.
        </p>
      )}
      {!running && hasUnreadySelection && (
        <p className="text-center text-[9px] leading-snug text-amber-300/65" role="status">
          Finish setting up the selected searches before running this board.
        </p>
      )}

      {recoveryError ? (
        <div className="flex w-full gap-1.5">
          <button
            type="button"
            onClick={onRetry}
            disabled={!canRetry}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-indigo-500/25 bg-indigo-500/20 px-2 py-1.5 text-[10px] font-medium text-indigo-100 transition-colors hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Search size={11} />
            Retry recovery
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={!recoveryCanCancel || typeof onCancel !== 'function'}
            className="flex items-center justify-center gap-1 rounded-lg border border-rose-500/25 bg-rose-500/15 px-2 py-1.5 text-[10px] font-medium text-rose-100 transition-colors hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={11} />
            Cancel
          </button>
        </div>
      ) : (
      <div className="flex w-full gap-1.5">
        <button
          type="button"
          onClick={running ? onCancel : onRun}
          disabled={running ? !canCancel : !canRun}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            running
              ? 'border-rose-500/25 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25'
              : 'border-indigo-500/25 bg-indigo-500/20 text-indigo-100 hover:bg-indigo-500/30'
          }`}
          title={running
            ? 'Cancel this Board run and keep existing completed results'
            : selectedRows.length === 0
              ? 'Select at least one connected Job Search module'
              : hasUnreadySelection
                ? 'Finish setting up the selected searches first'
                : 'Run the selected Job Search modules. If a source needs manual attention, resolve it there; this Board continues and combines saved results automatically.'}
        >
          {running ? <X size={11} /> : <Search size={11} />}
          {running ? 'Cancel current run' : 'Search selected & combine'}
        </button>
      </div>
      )}
    </fieldset>
  );
}
