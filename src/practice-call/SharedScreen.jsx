import React from 'react';
import { parseInline, parseScreenContent } from './screenMarkup.js';

function Inline({ text }) {
  return parseInline(text).map((part, index) => {
    if (part.type === 'code') return <code key={index} className="rounded bg-[#f1f3f4] px-1 py-0.5 font-mono text-[0.9em] text-[#202124]">{part.text}</code>;
    if (part.type === 'bold') return <strong key={index} className="font-semibold">{part.text}</strong>;
    return <React.Fragment key={index}>{part.text}</React.Fragment>;
  });
}

// What the interviewer is presenting, drawn as a light "window" on the dark stage.
// Every value is a React child, never markup, so content cannot inject anything.
export default function SharedScreen({ title, content, presenterName = '', className = '' }) {
  const blocks = parseScreenContent(content);
  return <section aria-label="Shared screen" data-shared-screen="true" className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-white text-[#202124] ${className}`}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8eaed] px-4 py-2.5">
      <h2 className="truncate text-sm font-medium">{title || 'Shared screen'}</h2>
      {presenterName && <span className="shrink-0 rounded-full bg-[#202124]/80 px-2.5 py-1 text-xs text-white">{presenterName} (Presentation)</span>}
    </header>
    <div data-screen-body="true" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-[15px] leading-relaxed">
      {blocks.length === 0 && <p className="text-[#5f6368]">Nothing on the screen yet.</p>}
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return <pre key={index} data-code-lang={block.lang || undefined} className="overflow-x-auto rounded-lg bg-[#1e1f22] p-3 font-mono text-[13px] leading-5 text-[#e8eaed]"><code>{block.text}</code></pre>;
        }
        if (block.type === 'ul') {
          return <ul key={index} className="list-disc space-y-1 pl-5">{block.items.map((item, at) => <li key={at}><Inline text={item} /></li>)}</ul>;
        }
        return <p key={index} className="whitespace-pre-line break-words"><Inline text={block.text} /></p>;
      })}
    </div>
  </section>;
}
