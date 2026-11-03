import React, { useState } from 'react';

export function CopyBriefButton({ brief }) {
  const [state, setState] = useState('idle');
  const text = typeof brief === 'string' ? brief.trim() : '';
  if (!text) return null;
  const copy = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1500);
  };
  return (
    <button type="button" className="nodrag rounded px-1 text-[9px] text-white/45 hover:bg-white/10 hover:text-white/70" onPointerDown={(e) => e.stopPropagation()} onClick={copy}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}
