import React from 'react';
import { Dialog } from './Dialog';
import { RefreshCw, Loader2, Info, AlertTriangle, AlertCircle } from 'lucide-react';

/**
 * Severity icon + color mapping for activity signals.
 */
const SEVERITY_CONFIG = {
  alert:   { icon: AlertTriangle, color: '#ef4444', bg: 'bg-red-500/10'   },
  warning: { icon: AlertCircle,   color: '#f59e0b', bg: 'bg-amber-500/10' },
  info:    { icon: Info,           color: '#3b82f6', bg: 'bg-blue-500/10'  },
};

/**
 * Signal Results Dialog — displays Gemini analysis results.
 */
export function SignalResultsDialog({ signals, lastChecked, platform, color, onClose, onMarkRead, onMarkAllRead, onRecheck, isChecking }) {
  const unreadCount = signals.filter(s => !s.read).length;

  return (
    <Dialog title={`AI Signals — ${platform}`} onClose={onClose} width="w-[420px]">
      {/* Header info */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-white/30 text-[11px]">
          {lastChecked ? `Checked at ${lastChecked}` : 'Not checked yet'}
        </span>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
              onClick={onMarkAllRead}
            >
              Mark all read
            </button>
          )}
          <button
            onClick={onRecheck}
            disabled={isChecking}
            className="text-[11px] flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors text-white/60 hover:text-white/90 disabled:opacity-40"
          >
            {isChecking ? (
              <><Loader2 size={10} className="animate-spin" /> Checking…</>
            ) : (
              <><RefreshCw size={10} /> Recheck</>
            )}
          </button>
        </div>
      </div>

      {/* Signals list */}
      {signals.length === 0 ? (
        <div className="text-white/30 text-sm text-center py-6 flex flex-col items-center gap-2">
          <Info size={24} className="text-white/15" />
          {lastChecked ? 'No signals found on this page' : 'Click "Recheck" to analyze this listing'}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto custom-scrollbar pr-1">
          {signals.map((signal) => {
            const sev = SEVERITY_CONFIG[signal.severity] || SEVERITY_CONFIG.info;
            const SevIcon = sev.icon;
            return (
              <button
                key={signal.id}
                className={`text-left p-2.5 rounded-lg border transition-all ${
                  signal.read
                    ? 'bg-white/[0.02] border-white/5 opacity-50'
                    : `${sev.bg} border-white/10 hover:border-white/20`
                }`}
                onClick={() => { if (!signal.read) onMarkRead(signal.id); }}
              >
                <div className="flex items-start gap-2">
                  <SevIcon size={14} style={{ color: sev.color }} className="shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold" style={{ color: sev.color }}>
                        {signal.type}
                      </span>
                      {!signal.read && (
                        <span className="text-[9px] text-blue-400 shrink-0">● new</span>
                      )}
                    </div>
                    <p className="text-white/80 text-xs mt-0.5 leading-relaxed">{signal.description}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-between">
        <span className="text-white/20 text-[10px]">Powered by Gemini AI</span>
        <span className="text-[10px]" style={{ color: color + '80' }}>
          {signals.length} signal{signals.length !== 1 ? 's' : ''} · {unreadCount} unread
        </span>
      </div>
    </Dialog>
  );
}
