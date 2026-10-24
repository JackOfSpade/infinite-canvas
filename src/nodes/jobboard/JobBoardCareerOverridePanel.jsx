import React from 'react';

import { TwoStepConfirmButton } from '../jobsearch/TwoStepConfirmButton';

const BUTTON_CLASS = 'nodrag rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-white/70 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';
const ARMED_CLASS = 'nodrag rounded-full border border-red-400/40 bg-red-500/20 px-2.5 py-1 text-[10px] text-red-100';

function formatDate(time) {
  if (!Number.isFinite(time) || time <= 0) return 'earlier';
  try {
    return new Date(time).toLocaleDateString();
  } catch {
    return 'earlier';
  }
}

function FileList({ names }) {
  if (!Array.isArray(names) || names.length === 0) return null;
  return (
    <p className="mt-0.5 text-[9px] leading-snug text-white/40 break-words">{names.join(', ')}</p>
  );
}

function ImportControls({ disabled, onDropFiles, onPickFiles, onOpenCanvasFiles }) {
  const handleDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  };
  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    onDropFiles?.(event);
  };
  return (
    <div className="mt-1.5 space-y-1.5">
      <div
        className={`nodrag rounded-md border border-dashed border-white/15 bg-white/5 px-2 py-2 text-center text-[9px] text-white/40 ${disabled ? 'opacity-40' : ''}`}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        Drop .txt or .md career files here
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        <label className={`${BUTTON_CLASS} ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
          Choose files from Mac
          <input
            type="file"
            multiple
            accept=".txt,.md,text/plain,text/markdown"
            className="sr-only"
            disabled={disabled}
            onChange={onPickFiles}
          />
        </label>
        <button type="button" className={BUTTON_CLASS} disabled={disabled} onClick={onOpenCanvasFiles}>
          Choose canvas files
        </button>
      </div>
    </div>
  );
}

export function JobBoardCareerOverridePanel({
  view,
  busy = false,
  onDropFiles,
  onPickFiles,
  onOpenCanvasFiles,
  onResume,
  onDiscard,
  onClear,
}) {
  const state = view?.state || 'empty';
  const importDisabled = !view?.canImport || busy;
  const approved = view?.approved || null;
  const pending = view?.pending || null;
  const showImport = state === 'empty' || state === 'approved';

  return (
    <div
      className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-2"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <p className="text-[10px] font-semibold text-white/70">Career data for applications and salary guidance</p>
      <p className="text-[9px] leading-snug text-white/30">
        Used for this board&apos;s applications and salary guidance. When empty, both use the most recently imported career data from a connected Job Search. Re-combine to refresh salary guidance after changing career data.
      </p>

      {approved && (
        <div className="mt-1.5">
          <p className="text-[10px] leading-snug text-emerald-200/80 break-words">
            Applications and salary guidance use: {approved.fileNames.join(', ') || 'compiled career data'}, compiled {formatDate(approved.approvedAt)}
          </p>
          {state === 'approved' && (
            <div className="mt-1 flex justify-center">
              <TwoStepConfirmButton
                label="Clear"
                confirmLabel="Click again to clear"
                title="Applications and salary guidance fall back to the latest career data from a connected Job Search"
                onConfirm={onClear}
                disabled={!view?.canClear || busy}
                className={BUTTON_CLASS}
                armedClassName={ARMED_CLASS}
              />
            </div>
          )}
        </div>
      )}

      {state === 'compiling' && (
        <div className="mt-1.5">
          <p className="text-[10px] leading-snug text-blue-200/80">
            Compiling career data for applications… answer its handoffs in the dock.
          </p>
          <FileList names={pending?.fileNames} />
        </div>
      )}

      {state === 'interrupted' && (
        <div className="mt-1.5">
          <p className="text-[10px] leading-snug text-amber-200/80">Career compilation was interrupted.</p>
          <FileList names={pending?.fileNames} />
          <div className="mt-1 flex justify-center gap-1.5">
            <button type="button" className={BUTTON_CLASS} disabled={!view?.canResume || busy} onClick={onResume}>Resume</button>
            <button type="button" className={BUTTON_CLASS} disabled={!view?.canDiscard || busy} onClick={onDiscard}>Discard</button>
          </div>
        </div>
      )}

      {state === 'failed' && (
        <div className="mt-1.5">
          <p role="alert" className="text-[10px] leading-snug text-red-200/80 break-words">
            {pending?.error || 'Failed to compile career files'}
          </p>
          <FileList names={pending?.fileNames} />
          <div className="mt-1 flex justify-center gap-1.5">
            <button type="button" className={BUTTON_CLASS} disabled={!view?.canResume || busy} onClick={onResume}>Retry</button>
            <button type="button" className={BUTTON_CLASS} disabled={!view?.canDiscard || busy} onClick={onDiscard}>Discard</button>
          </div>
        </div>
      )}

      {showImport && (
        <ImportControls
          disabled={importDisabled}
          onDropFiles={onDropFiles}
          onPickFiles={onPickFiles}
          onOpenCanvasFiles={onOpenCanvasFiles}
        />
      )}

      {view?.retirePendingCount > 0 && (
        <p className="mt-1 text-center text-[8px] text-white/25">retrying handoff cleanup</p>
      )}
    </div>
  );
}
