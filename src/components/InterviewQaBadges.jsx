import React from 'react';

/** Keep provenance visible even when a card has no prepared answer. */
export function InterviewQaBadges({ card, details = false }) {
  const originLabel = { disclosed: 'Disclosed', posting: 'From posting', research: 'From research', catalog: 'Standard', user: 'Your card' }[card.origin];
  const url = /^https?:\/\//i.test(card.source?.url || '') ? card.source.url : null;
  return <div className="interview-qa-badges flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-muted)]">
    {originLabel && (url ? <a className="qa-origin rounded border border-current px-1 underline" href={url} target="_blank" rel="noreferrer">{originLabel}</a> : <span className="qa-origin rounded border border-current px-1">{originLabel}</span>)}
    {card.author === 'user' && <span className="qa-edited">Edited by you</span>}
    {card.status === 'needs-prep' && <span className="qa-needs-prep text-amber-500">Needs prep</span>}
    {card.status === 'empty' && <span className="qa-empty text-amber-500">Empty</span>}
    {details && card.source && <details className="w-full"><summary className="cursor-pointer">Question source</summary>
      {card.source.date && <p>Source date: {card.source.date}</p>}
      {card.source.quote && <blockquote className="mt-1 border-l-2 border-[var(--border-main)] pl-2">{card.source.quote}</blockquote>}
    </details>}
  </div>;
}
