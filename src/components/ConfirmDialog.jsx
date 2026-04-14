import React from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

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

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel, variant = 'danger' }) {
  const style = VARIANT_STYLES[variant] || VARIANT_STYLES.danger;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[360px] bg-neutral-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden onboarding-panel"
        onClick={(e) => e.stopPropagation()}
      >
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
