import React, { useId, useState } from 'react';
import { JOB_SOURCE_BY_ID } from '../utils/constants';
import { getEnabledJobSourceIds, getJobPlatformSelectionStatus, normalizeEnabledJobSourceIds } from '../utils/jobPlatformSelection';

/** Per-hub source allow-list for the next job-search run. */
export function JobPlatformSelectionControl({
  enabledSourceIds,
  setEnabledSourceIds,
  collectionLimits,
  availableSourceIds,
  searchLocation = null,
  disabled = false,
}) {
  const idPrefix = useId();
  const available = Array.isArray(availableSourceIds) ? availableSourceIds : [];
  const persisted = normalizeEnabledJobSourceIds(enabledSourceIds);
  const selected = getEnabledJobSourceIds(persisted, available);
  const selectedSet = new Set(selected);
  const [attemptedUnsafeId, setAttemptedUnsafeId] = useState(null);
  const unsafe = available
    .map(sourceId => getJobPlatformSelectionStatus(sourceId, collectionLimits, searchLocation))
    .filter(status => !status.enabled);
  const unsafeIds = new Set(unsafe.map(status => status.sourceId));
  const warningId = `${idPrefix}-platform-warning`;
  const attemptedUnsafe = unsafe.find(status => status.sourceId === attemptedUnsafeId) || null;
  // A setting change can make an already-selected platform unsafe. Keep that
  // preference for automatic re-enable, but make the forced disable explicit.
  const persistedUnsafe = unsafe.find(status => persisted.includes(status.sourceId)) || null;
  const visibleWarning = attemptedUnsafe || persistedUnsafe;

  const toggle = (sourceId) => {
    if (unsafeIds.has(sourceId)) {
      setAttemptedUnsafeId(sourceId);
      return;
    }
    const next = persisted.includes(sourceId)
      ? persisted.filter(id => id !== sourceId)
      : [...persisted, sourceId];
    // Toggle the complete persisted selection so a source hidden by test scope
    // is not accidentally erased while the user edits the visible list.
    setEnabledSourceIds?.(normalizeEnabledJobSourceIds(next));
  };

  return (
    <fieldset
      className="nodrag w-full rounded border border-white/8 bg-white/[0.025] px-2 py-1.5"
      onPointerDown={(event) => event.stopPropagation()}
      disabled={disabled}
    >
      <legend className="px-1 text-[9px] text-white/30">Job platforms</legend>
      <p className="mb-1 text-[8px] leading-snug text-white/25">Choose the platforms to search on the next run.</p>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {available.map((sourceId) => {
          const source = JOB_SOURCE_BY_ID[sourceId];
          const safety = unsafe.find(status => status.sourceId === sourceId);
          const inputId = `${idPrefix}-${sourceId}`;
          return (
            <label
              key={sourceId}
              htmlFor={inputId}
              className={`flex min-w-0 items-center gap-1 text-[9px] ${safety ? 'cursor-not-allowed text-amber-200/55' : 'cursor-pointer text-white/55'}`}
              title={safety?.reason || source?.name || sourceId}
              onClick={() => { if (safety) setAttemptedUnsafeId(sourceId); }}
            >
              <input
                id={inputId}
                type="checkbox"
                checked={selectedSet.has(sourceId) && !safety}
                disabled={disabled || !!safety}
                aria-disabled={!!safety}
                aria-describedby={safety ? warningId : undefined}
                onChange={() => toggle(sourceId)}
                className="accent-blue-400 disabled:cursor-not-allowed"
              />
              <span className="truncate">{source?.name || sourceId}</span>
            </label>
          );
        })}
      </div>
      {selected.filter(sourceId => !unsafeIds.has(sourceId)).length === 0 && (
        <p className="mt-1 text-[8px] leading-snug text-amber-200/80" role="alert">Select at least one platform before running.</p>
      )}
      {visibleWarning && (
        <p id={warningId} className="mt-1 text-[8px] leading-snug text-amber-200/80" role="alert">
          {JOB_SOURCE_BY_ID[visibleWarning.sourceId]?.name || visibleWarning.sourceId}: {visibleWarning.reason}
        </p>
      )}
    </fieldset>
  );
}
