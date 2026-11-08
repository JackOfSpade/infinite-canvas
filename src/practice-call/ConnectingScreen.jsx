import React from 'react';
import { Phone } from 'lucide-react';
import { initialsOf } from './persona.js';

export default function ConnectingScreen({ persona }) {
  return <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#111018] p-4 text-violet-50" aria-label="Connecting practice call">
    <div className="grid h-16 w-16 place-items-center rounded-full bg-violet-500/20 text-xl font-semibold text-violet-100 animate-pulse" aria-hidden="true">{initialsOf(persona)}</div>
    <h1 className="text-sm font-semibold text-violet-50">Connecting to {persona?.name || 'the interviewer'}…</h1>
    <p role="status" className="flex items-center gap-1 text-[11px] text-white/55"><Phone size={11} aria-hidden="true" />The call starts as soon as they pick up.</p>
  </main>;
}
