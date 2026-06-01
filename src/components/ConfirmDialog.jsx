import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { updateModalCount } from './modalStack';

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

  // Participate in the modal stack so global shortcuts (undo/redo) are suppressed
  // while a destructive confirm is showing — otherwise Cmd+Z on the canvas
  // underneath could mutate state mid-confirmation. (Dialog already does this.)
  useEffect(() => {
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, []);

  // Close on Escape — Escape always means "no further action", which matches
  // the Cancel button (not Abort — we don't want a misfired Escape to undo
  // user state changes that pre-dated this dialog).
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[360px] bg-neutral-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden onboarding-panel relative"
        onClick={(e) => e.stopPropagation()}
      >
        {onAbort && (
          <button
            onClick={onAbort}
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
            <p className="text-white/50 text-xs leading-relaxed">{message}</p>
          </div>
        </div>

        <div className="px-6 pb-6 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded-lg text-xs font-medium bg-white/5 text-white/70 hover:bg-white/10 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
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
