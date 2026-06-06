import React from 'react';
import { X, ShieldAlert } from 'lucide-react';

/**
 * Paused state shown between scrape and AI synthesis when some sources errored
 * or hit captcha. The per-card Solve / Skip buttons drive the decision; this
 * view just summarizes status and offers a Cancel-everything escape hatch.
 * AI synthesis auto-fires the moment the last warned card is resolved or
 * skipped.
 */
export function SellHubCompsReadyDecision({ scrapeWarnings, compsTotal = 0, onCancel }) {
  const total = compsTotal;
  const blocked = scrapeWarnings.length;
  return (
    <div className="p-3 space-y-2" onPointerDown={(e) => e.stopPropagation()}>
      <div className="text-amber-400/80 text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1">
        <ShieldAlert size={11} /> {blocked} blocked
      </div>
      <div className="text-white/60 text-[11px] leading-snug">
        Scrape found <span className="text-white/90 font-medium">{total} similar listing{total === 1 ? '' : 's'}</span>. {blocked} source(s) need attention — use each card&apos;s <span className="text-white/80 font-medium">Solve</span> or <span className="text-white/80 font-medium">Skip</span>. Pricing runs automatically once they&apos;re all handled.
      </div>
      <ul className="text-[9px] text-white/40 space-y-0.5 pl-2">
        {scrapeWarnings.slice(0, 5).map((w, i) => (
          <li key={i}>• <span className="text-white/60 font-mono">{w.sourceId}</span> — {w.code}</li>
        ))}
        {scrapeWarnings.length > 5 && (
          <li className="opacity-60">• +{scrapeWarnings.length - 5} more</li>
        )}
      </ul>
      <button
        onClick={onCancel}
        className="nodrag w-full flex items-center justify-center gap-1 py-1.5 rounded text-[10px] font-medium bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80 transition-colors border border-white/10"
        title="Cancel and return to draft — your product info stays intact"
      >
        <X size={10} /> Cancel
      </button>
    </div>
  );
}
