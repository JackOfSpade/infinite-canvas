import React, { useId, useLayoutEffect, useMemo, useRef } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react';
import { jobBoardModuleReadiness, jobBoardSelectionPresentation } from '../../utils/jobBoardSearchSelection.js';

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
      : currentLabel || 'Starting or continuing selected sources…');

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

function roundedLayoutValue(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function layoutBounds(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect?.();
  return {
    width: roundedLayoutValue(rect?.width ?? element.clientWidth),
    height: roundedLayoutValue(rect?.height ?? element.clientHeight),
    clientWidth: roundedLayoutValue(element.clientWidth),
    clientHeight: roundedLayoutValue(element.clientHeight),
    scrollWidth: roundedLayoutValue(element.scrollWidth),
    scrollHeight: roundedLayoutValue(element.scrollHeight),
  };
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
  onMove = null,
  disabled = false,
  running = false,
  progress = null,
  onRun,
  onCancel = null,
  recoveryError = null,
  onRetry = null,
  recoveryActionLabel = 'Retry recovery',
  recoveryCanCancel = true,
  onRuntimeSnapshot = null,
  upToDate = false,
}) {
  const fieldsetId = useId();
  const fieldsetRef = useRef(null);
  const sourceListRef = useRef(null);
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
        readiness: jobBoardModuleReadiness(module),
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
          accessibleName: `Select ${row.label}, Job Search ${suffix}, to start or continue`,
        },
      };
    });
  }, [modules]);
  const selectedRows = useMemo(
    () => rows.filter(({ module }) => selectedSet.has(module.id)),
    [rows, selectedSet],
  );
  const hasUnreadySelection = selectedRows.some(({ readiness }) => !readiness.ready);
  const presentation = jobBoardSelectionPresentation(selectedRows.map(({ module }) => module));
  const { runLabel } = presentation;
  const controlsDisabled = disabled || running || !!recoveryError;
  // `upToDate` is the Board's verdict that it is done, current and complete.
  // It never applies while running or recovering: those states own the live
  // Cancel / Retry controls.
  const boardUpToDate = upToDate === true && !running && !recoveryError;
  const canRun = !boardUpToDate
    && !controlsDisabled
    && typeof onRun === 'function'
    && selectedRows.length > 0
    && !hasUnreadySelection;
  const canCancel = running && recoveryCanCancel && typeof onCancel === 'function';
  const canRetry = !!recoveryError && !disabled && typeof onRetry === 'function';
  const progressState = normalizeProgress(progress, selectedRows.length);
  const actionDisabledReasonId = `${fieldsetId}-run-reason`;
  // An idle primary action can be disabled by setup, a Board lock, or a
  // missing callback. Keep a real explanation beside the native disabled
  // control: colour alone made the prior low-opacity indigo state easy to
  // mistake for an available action.
  const primaryActionDisabledReason = !running && !recoveryError && !boardUpToDate && !canRun
    ? disabled
      ? 'Unlock this Job Board before starting or continuing searches.'
      : selectedRows.length === 0
        ? 'Select at least one connected Job Search source to start or continue.'
        : hasUnreadySelection
          ? presentation.unreadyMessage
          : 'This Job Board is not ready to start searches yet.'
    : null;
  const eligibilityReasons = useMemo(() => [
    disabled ? 'board-disabled' : null,
    running ? 'board-running' : null,
    recoveryError ? 'recovery-error' : null,
    boardUpToDate ? 'board-up-to-date' : null,
    selectedRows.length === 0 ? 'no-selection' : null,
    hasUnreadySelection ? 'selected-source-unready' : null,
    typeof onRun !== 'function' ? 'run-handler-unavailable' : null,
  ].filter(Boolean), [boardUpToDate, disabled, hasUnreadySelection, recoveryError, running, selectedRows.length, onRun]);
  const eligibilityReasonKey = eligibilityReasons.join('|');

  // The action predicate is split between Board state and selector state. Keep
  // a bounded snapshot of exactly what this mounted control evaluated, plus
  // client/scroll measurements, for the existing FULL Board diagnostics.
  useLayoutEffect(() => {
    if (typeof onRuntimeSnapshot !== 'function') return undefined;
    const emit = () => onRuntimeSnapshot({
      rowCount: rows.length,
      selectedCount: selectedRows.length,
      actionEligible: canRun,
      actionVisible: !boardUpToDate,
      actionLabel: String(runLabel || '').slice(0, 80),
      eligibilityReasons: eligibilityReasonKey ? eligibilityReasonKey.split('|') : [],
      selectorBounds: layoutBounds(fieldsetRef.current),
      sourceListBounds: layoutBounds(sourceListRef.current),
    });
    emit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(emit);
    if (fieldsetRef.current) observer.observe(fieldsetRef.current);
    if (sourceListRef.current) observer.observe(sourceListRef.current);
    return () => observer.disconnect();
  }, [boardUpToDate, canRun, eligibilityReasonKey, onRuntimeSnapshot, rows.length, runLabel, selectedRows.length]);

  return (
    <fieldset
      ref={fieldsetRef}
      className="nodrag min-w-0 w-full max-w-full space-y-2"
      onPointerDown={(event) => event.stopPropagation()}
      aria-busy={running}
    >
      <legend className="flex min-w-0 w-full max-w-full items-center justify-between gap-2 px-0.5 text-[9px] uppercase tracking-wider text-white/35">
        <span className="min-w-0 truncate">Job Search sources</span>
        {rows.length > 0 && (
          <span className="shrink-0 normal-case tracking-normal text-white/25">
            {selectedRows.length}/{rows.length} selected
          </span>
        )}
      </legend>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-white/10 px-2 py-3 text-center text-[10px] leading-snug text-white/30">
          Connect Job Search modules to choose which sources to start or continue. Completed connected results are reused when the Board combines.
        </div>
      ) : (
        <div ref={sourceListRef} className="min-w-0 max-w-full max-h-44 space-y-1 overflow-x-hidden overflow-y-auto" role="group" aria-label="Connected Job Search sources to start or continue">
          {rows.map(({ module, label, readiness, discriminator }, index) => {
            const checked = selectedSet.has(module.id);
            const rowDisabled = controlsDisabled || module.disabled === true || module.selectable === false;
            const canMove = !rowDisabled && typeof onMove === 'function';
            const descriptionId = readiness.reason ? `${fieldsetId}-module-${index}-reason` : undefined;
            const StatusIcon = readiness.active
              ? Loader2
              : readiness.ready ? CheckCircle2 : AlertCircle;
            return (
              <div
                key={module.id}
                className={`flex min-w-0 max-w-full items-start gap-2 overflow-hidden rounded-md border px-2 py-1.5 transition-colors ${
                  checked
                    ? 'border-indigo-500/25 bg-indigo-500/10'
                    : 'border-white/5 bg-white/[0.03] hover:bg-white/5'
                } ${rowDisabled ? 'opacity-55' : ''}`}
              >
                <label className={`flex min-w-0 flex-1 items-start gap-2 ${rowDisabled ? 'cursor-default' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={rowDisabled}
                    aria-label={discriminator?.accessibleName || `Select ${label} to start or continue`}
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
                    <span
                      className={`mt-0.5 flex min-w-0 max-w-full items-center gap-1 text-[9px] ${
                        readiness.ready ? 'text-emerald-300/65' : 'text-amber-300/75'
                      }`}
                      title={readiness.label}
                    >
                      <StatusIcon size={9} className={`shrink-0 ${readiness.active ? 'animate-spin' : ''}`} aria-hidden="true" />
                      <span className="truncate">{readiness.label}</span>
                    </span>
                    {readiness.reason && (
                      <span id={descriptionId} className="mt-0.5 block break-words text-[9px] leading-snug text-amber-300/65">
                        {readiness.reason}
                      </span>
                    )}
                  </span>
                </label>
                {typeof onMove === 'function' && (
                  <span className="flex shrink-0 flex-col" role="group" aria-label={`Recovery and reconciliation order for ${label}`}>
                    <button
                      type="button"
                      disabled={!canMove || index === 0}
                      aria-label={`Move ${label} earlier`}
                      title="Prioritize this search earlier for recovery and result reconciliation"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onMove(module.id, 'up');
                      }}
                      className="rounded p-0.5 text-white/35 hover:bg-white/10 hover:text-white/70 disabled:cursor-default disabled:opacity-25"
                    >
                      <ChevronUp size={11} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={!canMove || index === rows.length - 1}
                      aria-label={`Move ${label} later`}
                      title="Prioritize this search later for recovery and result reconciliation"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onMove(module.id, 'down');
                      }}
                      className="rounded p-0.5 text-white/35 hover:bg-white/10 hover:text-white/70 disabled:cursor-default disabled:opacity-25"
                    >
                      <ChevronDown size={11} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </div>
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

      {primaryActionDisabledReason && (
        <p id={actionDisabledReasonId} className="text-center text-[9px] leading-snug text-amber-300/65" role="status">
          {primaryActionDisabledReason}
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
            {recoveryActionLabel}
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
      ) : boardUpToDate ? (
        <p
          role="status"
          data-action-state="up-to-date"
          className="text-center text-[9px] leading-snug text-emerald-300/70"
        >
          Board is up to date — every connected search is combined. Change a source or add one to combine again.
        </p>
      ) : (
      <div className="flex w-full gap-1.5">
        <button
          type="button"
          onClick={running ? onCancel : onRun}
          disabled={running ? !canCancel : !canRun}
          aria-describedby={primaryActionDisabledReason ? actionDisabledReasonId : undefined}
          data-action-state={running ? 'running' : (canRun ? 'enabled' : 'disabled')}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed ${
            running
              ? 'border-rose-500/25 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25 disabled:opacity-40'
              : canRun
                ? 'border-indigo-300/80 bg-indigo-500 text-white shadow-[0_0_16px_rgba(99,102,241,0.45)] hover:bg-indigo-400 hover:shadow-[0_0_20px_rgba(99,102,241,0.6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200/90 focus-visible:ring-offset-1 focus-visible:ring-offset-[#111827]'
                : 'border-white/10 bg-white/[0.04] text-white/35 shadow-none opacity-70'
          }`}
          title={running
            ? 'Cancel this Board run and keep existing completed results'
            : primaryActionDisabledReason || presentation.title}
        >
          {running ? <X size={11} /> : <Search size={11} />}
          {running ? 'Cancel current run' : runLabel}
        </button>
      </div>
      )}
    </fieldset>
  );
}
