import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { updateModalCount } from './modalStack';
import { TIMINGS } from '../utils/timings';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

/**
 * Styled confirmation dialog — replaces the browser-native `confirm()`.
 * Supports title, message, and confirm/cancel action labels.
 */

const VARIANT_STYLES = {
  danger: {
    icon: 'text-red-400',
    button: 'bg-red-500 hover:bg-red-600 text-white',
  },
  warning: {
    icon: 'text-amber-400',
    button: 'bg-amber-500 hover:bg-amber-600 text-white',
  },
  info: {
    icon: 'text-blue-400',
    button: 'bg-blue-500 hover:bg-blue-600 text-white',
  },
};

/**
 * Three-action confirmation dialog.
 *   - Confirm:  the affirmative action (e.g. "Move to Trash")
 *   - Cancel:   decline the affirmative action; whatever surrounding work
 *               already happened stays (e.g. "Keep OS File" after a canvas
 *               delete that already removed the nodes)
 *   - Abort (X, top-left, optional): undo everything related to this prompt.
 *               Only renders when `onAbort` is provided — used by flows like
 *               "delete on disk?" where the caller can also restore the
 *               canvas deletion that triggered the prompt.
 *
 * Escape and clicking the backdrop both resolve to onCancel — they match the
 * passive "close this dialog" intent. Use the X explicitly to undo.
 */
export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel, onAbort, variant = 'danger' }) {
  const style = VARIANT_STYLES[variant] || VARIANT_STYLES.danger;
  const [isResolving, setIsResolving] = useState(false);
  const dialogRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  const resolvingRef = useRef(false);
  const resolveTimerRef = useRef(null);

  const focusableElements = useCallback(() => {
    if (!dialogRef.current) return [];
    return [...dialogRef.current.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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

  const resolveOnce = useCallback((action) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setIsResolving(true);
    // Keep the backdrop mounted briefly so a rapid second click cannot land on
    // the canvas underneath after the first action unmounts this dialog.
    resolveTimerRef.current = setTimeout(action, TIMINGS.MODAL_RESOLVE_GUARD_MS);
  }, []);

  // Participate in the modal stack so global shortcuts (undo/redo) are suppressed
  // while a destructive confirm is showing — otherwise Cmd+Z on the canvas
  // underneath could mutate state mid-confirmation. (Dialog already does this.)
  useEffect(() => {
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, []);

  // A portal sits at the end of document.body, so focus would otherwise stay
  // on an obscured canvas control. Start on the safe action and return focus
  // to the control that opened the dialog after it closes.
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    cancelButtonRef.current?.focus();
    return () => {
      const previousFocus = previousFocusRef.current;
      if (previousFocus instanceof HTMLElement && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    };
  }, []);

  // Close on Escape — Escape always means "no further action", which cancels
  // the dialog (triggers onAbort to undo if available, else falls back to onCancel).
  useEscapeToClose((e) => {
    e.preventDefault();
    resolveOnce(onAbort || onCancel);
  });

  useEffect(() => () => {
    if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);
  }, []);

  return createPortal(
      <div
        className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={() => resolveOnce(onAbort || onCancel)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="w-[360px] max-w-full min-w-0 bg-neutral-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden onboarding-panel relative"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapFocus}
      >
        {onAbort && (
          <button
            onClick={() => resolveOnce(onAbort)}
            disabled={isResolving}
            className="absolute top-2.5 left-2.5 text-white/30 hover:text-white/70 transition-colors p-1 rounded hover:bg-white/5"
            title="Cancel and undo (restores anything this dialog was about to act on)"
            aria-label="Cancel and undo"
          >
            <X size={14} />
          </button>
        )}

        <div className="p-6 flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center">
            <AlertTriangle size={24} className={style.icon} />
          </div>
          <div className="text-center">
            <h3 className="text-white text-sm font-semibold mb-1">{title}</h3>
            <p className="text-white/50 text-xs leading-relaxed whitespace-pre-line">{message}</p>
          </div>
        </div>

        <div className="px-6 pb-6 flex gap-3">
          <button
            ref={cancelButtonRef}
            onClick={() => resolveOnce(onCancel)}
            disabled={isResolving}
            className="flex-1 px-4 py-2.5 rounded-lg text-xs font-medium bg-white/5 text-white/70 hover:bg-white/10 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => resolveOnce(onConfirm)}
            disabled={isResolving}
            className={`flex-1 px-4 py-2.5 rounded-lg text-xs font-medium transition-colors ${style.button}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
