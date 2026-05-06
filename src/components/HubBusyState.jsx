import React from 'react';
import { Loader2, XCircle } from 'lucide-react';

const SPINNER_THEMES = {
  amber: 'text-amber-400',
  blue: 'text-blue-400',
  emerald: 'text-emerald-400',
};

const SUBLINE_THEMES = {
  amber: 'text-amber-400/60',
  blue: 'text-blue-400/60',
  emerald: 'text-emerald-400/60',
};

/**
 * Spinner + cancel-button shell shared by the SellHub analyzing/researching
 * states and JobHub processing state. Cancel button reveals on hover.
 */
export function HubBusyState({ label, subline, theme = 'amber', onReset }) {
  return (
    <div className="group flex flex-col items-center justify-center py-6 px-4 relative">
      {onReset && (
        <button
          onClick={onReset}
          className="absolute top-2 right-2 p-1 text-white/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all rounded"
          title="Cancel/Reset Task"
        >
          <XCircle size={14} />
        </button>
      )}
      <Loader2 size={22} className={`animate-spin mb-2 ${SPINNER_THEMES[theme] || SPINNER_THEMES.amber}`} />
      {label && <p className="text-white/60 text-xs font-medium">{label}</p>}
      {subline && <p className={`text-[10px] mt-1 ${SUBLINE_THEMES[theme] || 'text-white/20'}`}>{subline}</p>}
    </div>
  );
}
