import React from 'react';
import { AlertTriangle, X, RefreshCw } from 'lucide-react';

/**
 * Inline error banner shown above the body of any hub node (SellHub, Job Search Module,
 * etc.). Replaces the dedicated 'error' hubState — the user wanted failures
 * to keep their place in the flow (still see/edit prior results, drop new
 * inputs) rather than be wiped to a "Try Again" wall.
 */
export function HubErrorBanner({ errorMessage, isRateLimit, locked, onRetry, onDismiss }) {
  const msg = String(errorMessage || '');
  const isBillingDepleted = /prepayment credits are depleted|billing|insufficient/i.test(msg);
  const headerLabel = !isRateLimit
    ? 'Last attempt failed'
    : isBillingDepleted ? 'Billing Credits Depleted' : 'Usage Limit Reached';

  return (
    <div className="m-2 p-2 rounded-md bg-red-500/10 border border-red-500/30" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-start gap-1.5">
        <AlertTriangle size={11} className="text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-red-300 text-[10px] font-semibold uppercase tracking-wider mb-0.5">
            {headerLabel}
          </div>
          <div className="text-white/70 text-[10px] leading-snug break-words">
            {errorMessage}
          </div>
          {isBillingDepleted && (
            <div className="text-white/40 text-[10px] mt-1 leading-snug">
              Billing is enabled but prepayment is empty — free tier no longer applies. Top up at Cloud Billing, or use a key from an account without billing.
            </div>
          )}
          <div className="flex gap-1 mt-1.5 flex-wrap">
            {!locked && onRetry && (
              <button
                onClick={(e) => { e.stopPropagation(); onRetry(); }}
                className="nodrag flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-[10px] font-medium transition-colors"
              >
                <RefreshCw size={9} /> Try again
              </button>
            )}
            {!locked && isRateLimit && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  document.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'ai' } }));
                }}
                className="nodrag px-1.5 py-0.5 rounded bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 text-[10px] font-medium transition-colors"
              >
                Change model / key
              </button>
            )}
            {!locked && isBillingDepleted && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.electronAPI?.openExternal?.('https://ai.google.dev/gemini-api/docs/billing#prepay');
                }}
                className="nodrag px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-[10px] font-medium transition-colors"
              >
                Top up billing
              </button>
            )}
          </div>
        </div>
        {!locked && onDismiss && (
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            className="nodrag text-white/30 hover:text-white/60 shrink-0"
            title="Dismiss"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
