import React from 'react';
import { AlertTriangle, X, RefreshCw } from 'lucide-react';

/**
 * Inline error banner shown above the body of any hub node (SellHub, Job Search Module,
 * etc.). Replaces the dedicated 'error' hubState — the user wanted failures
 * to keep their place in the flow (still see/edit prior results, drop new
 * inputs) rather than be wiped to a "Try Again" wall.
 */
export function HubErrorBanner({ errorMessage, isRateLimit, locked, onRetry, onDismiss }) {
  const headerLabel = isRateLimit ? 'Usage Limit Reached' : 'Last attempt failed';

  return (
    <div className="m-2 p-2 rounded-md bg-red-500/10 border border-red-500/30" role="alert" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-start gap-1.5">
        <AlertTriangle size={11} className="text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-red-300 text-[10px] font-semibold uppercase tracking-wider mb-0.5">
            {headerLabel}
          </div>
          <div className="text-white/70 text-[10px] leading-snug break-words">
            {errorMessage}
          </div>
          <div className="flex gap-1 mt-1.5 flex-wrap">
            {!locked && onRetry && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRetry(); }}
                className="nodrag flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-[10px] font-medium transition-colors"
              >
                <RefreshCw size={9} /> Try again
              </button>
            )}
          </div>
        </div>
        {!locked && onDismiss && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            className="nodrag text-white/30 hover:text-white/60 shrink-0"
            aria-label="Dismiss error"
            title="Dismiss"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
