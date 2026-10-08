import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { updateModalCount } from './modalStack';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { sameCareerCanvasFileSelection } from '../utils/careerCanvasFileImport';

/**
 * Accessible chooser for existing file cards on the *current* canvas level.
 *
 * The Job Search module owns eligibility and ingestion; this component only
 * presents an explicit, keyboard-operable selection UI. Keeping it free of
 * Electron/file-system calls makes it impossible for this route to import a
 * path that was not already represented by a canvas document node.
 */
export function CareerCanvasFileImportDialog({
  files,
  selectedSelections,
  onToggle,
  onClose,
  onImport,
  importDisabled = false,
}) {
  const dialogRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const selectedCount = selectedSelections.length;

  const focusableElements = useCallback(() => {
    if (!dialogRef.current) return [];
    return [...dialogRef.current.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
  }, []);

  const trapFocus = useCallback((event) => {
    if (event.key !== 'Tab') return;
    const elements = focusableElements();
    if (elements.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!dialogRef.current?.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [focusableElements]);

  useEffect(() => {
    updateModalCount(1);
    previousFocusRef.current = document.activeElement;
    // Start on Cancel, never on the potentially state-changing import action.
    cancelButtonRef.current?.focus();
    return () => {
      updateModalCount(-1);
      const previous = previousFocusRef.current;
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    };
  }, []);

  useEscapeToClose((event) => {
    event.preventDefault();
    onClose();
  }, { capture: true });

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="w-[420px] max-w-full overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/95 shadow-2xl"
        onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-white/10 px-5 py-4">
          <h3 id={titleId} className="text-sm font-semibold text-white">Import from canvas files</h3>
          <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-white/55">
            Select the career files already shown on this canvas. They will be compiled before any search begins.
          </p>
        </div>

        <div className="max-h-72 overflow-y-auto px-5 py-3">
          {files.length === 0 ? (
            <p className="py-3 text-xs leading-relaxed text-white/55">
              No compatible file cards are on this canvas level. Add or open a document file here, then try again.
            </p>
          ) : (
            <fieldset>
              <legend className="sr-only">Canvas career files</legend>
              <ul className="space-y-1">
                {files.map((file) => {
                  // A node id alone is not user consent for a later relinked
                  // file. The parent stores this exact id+path pair and a
                  // changed path visibly becomes unchecked until selected.
                  const checked = selectedSelections.some((selection) => sameCareerCanvasFileSelection(selection, file));
                  return (
                    <li key={file.nodeId}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-xs text-white/80 hover:bg-white/5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggle(file)}
                          aria-label={`Select ${file.filename} at ${file.filePath}`}
                          className="h-3.5 w-3.5 accent-blue-500"
                        />
                        <span className="min-w-0">
                          <span className="block truncate" title={file.filePath}>{file.filename}</span>
                          {/* The path is deliberately visible as well as in the
                              checkbox name: duplicate file names are common
                              in a career workspace and must remain distinct
                              without guessing which one the person meant. */}
                          <span className="block truncate text-[10px] text-white/45" title={file.filePath}>{file.filePath}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          )}
        </div>

        <div className="flex gap-3 border-t border-white/10 px-5 py-4">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg bg-white/5 px-4 py-2.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onImport}
            disabled={importDisabled || selectedCount === 0}
            className="flex-1 rounded-lg bg-blue-500 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {selectedCount === 1 ? 'Import 1 file' : `Import ${selectedCount} files`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
