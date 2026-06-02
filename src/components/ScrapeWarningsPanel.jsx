import React, { useState } from 'react';
import { ShieldAlert, ChevronDown, ChevronUp, Copy } from 'lucide-react';

/**
 * Collapsible panel for per-source anti-bot / throttle warnings produced
 * during a multi-source scrape. Used by both SellHubPricedState and
 * JobSearchDoneState — the ephemeral comp/job source cards show warnings
 * inline, but their data needs to survive after the cards are reaped,
 * which is what this panel does.
 *
 * Each warning is { sourceId, code, severity, evidence, suggestion }.
 * "Copy all" writes a single newline-separated block to the clipboard so
 * the user can paste the whole thing back into a bug report / chat.
 */
export function ScrapeWarningsPanel({ warnings = [], addToast }) {
  const [open, setOpen] = useState(false);
  if (!warnings || warnings.length === 0) return null;

  const blockCount    = warnings.filter(w => w?.severity === 'block').length;
  const throttleCount = warnings.length - blockCount;
  const dominant      = blockCount > 0 ? 'block' : 'throttle';
  const accent        = dominant === 'block' ? '#ef4444' : '#f59e0b';

  const handleCopyAll = async (e) => {
    e.stopPropagation();
    const text = warnings.map(w => (
      `[${w.sourceId}] ${w.severity?.toUpperCase() || 'WARN'} ${w.code}\n  evidence: ${w.evidence}\n  suggestion: ${w.suggestion}`
    )).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      addToast?.({ title: 'Warnings copied', description: `${warnings.length} entry(ies) on clipboard.`, type: 'success' });
    } catch {
      addToast?.({ title: 'Copy failed', description: 'Clipboard unavailable', type: 'error' });
    }
  };

  return (
    <div
      className="rounded-md border"
      style={{ borderColor: `${accent}55`, background: `${accent}10` }}
    >
      <button
        onClick={() => setOpen(v => !v)}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold"
        style={{ color: accent }}
        title="Anti-bot / throttle signals detected during scrape"
      >
        <ShieldAlert size={11} />
        <span className="flex-1 text-left">
          {blockCount > 0 && `${blockCount} blocked`}
          {blockCount > 0 && throttleCount > 0 && ' · '}
          {throttleCount > 0 && `${throttleCount} throttled`}
        </span>
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>
      {open && (
        <div
          className="px-2 pb-2 space-y-1.5 select-text cursor-text"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {warnings.map((w, i) => (
            <div
              key={`${w.sourceId}-${i}`}
              className="rounded border text-[9px] leading-snug p-1.5"
              style={{
                borderColor: `${w.severity === 'block' ? '#ef4444' : '#f59e0b'}33`,
                color: w.severity === 'block' ? '#fca5a5' : '#fcd34d',
              }}
            >
              <div className="font-semibold">
                [{w.sourceId}] {w.code}
              </div>
              <div className="font-mono break-words mt-0.5">{w.evidence}</div>
              <div className="opacity-80 break-words mt-0.5">{w.suggestion}</div>
            </div>
          ))}
          <button
            onClick={handleCopyAll}
            className="nodrag w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-medium border"
            style={{ borderColor: `${accent}55`, color: accent, background: `${accent}10` }}
          >
            <Copy size={9} /> Copy all warnings
          </button>
        </div>
      )}
    </div>
  );
}
