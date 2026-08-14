import React from 'react';

/**
 * Selectable warning evidence/suggestion panel shown on source cards
 * (JobSourceCardNode + CompSourceCardNode). The text is copy/paste-friendly so
 * the user can drop the full evidence + suggestion straight into a bug report.
 *
 * onPointerDown is always swallowed so dragging across the text doesn't start a
 * node drag. `stopClick` additionally swallows the click — needed on cards whose
 * outer wrapper has its own onClick (JobSource's filter toggle) so reading the
 * warning doesn't also fire that handler. Comp cards have no wrapper onClick, so
 * they leave it off to preserve their existing behavior.
 */
export function SourceWarningPanel({ warning, hasBlock, stopClick = false, note = null }) {
  if (!warning) return null;
  return (
    <div
      className="px-2.5 pb-1.5 pt-1 text-[9px] leading-snug select-text cursor-text"
      style={{ color: hasBlock ? '#fca5a5' : '#fcd34d', borderTop: `1px solid ${hasBlock ? '#ef444433' : '#f59e0b33'}` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={stopClick ? (e) => e.stopPropagation() : undefined}
      title="Copy this — paste back to debug"
    >
      {warning.evidence && <div className="font-mono break-words">{warning.evidence}</div>}
      {warning.suggestion && <div className="mt-0.5 opacity-80 break-words">{warning.suggestion}</div>}
      {note && <div className="mt-1 font-medium opacity-90 break-words">{note}</div>}
    </div>
  );
}
