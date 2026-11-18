import React from 'react';
import { Phone } from 'lucide-react';
import Avatar from './Avatar.jsx';

export default function ConnectingScreen({ persona }) {
  return <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#202124] p-4 text-violet-50" aria-label="Connecting practice call">
    <Avatar person={persona} className="h-16 w-16 text-2xl animate-pulse" />
    <h1 className="text-sm font-semibold text-violet-50">Connecting to {persona?.name || 'the interviewer'}…</h1>
    <p role="status" className="flex items-center gap-1 text-[11px] text-white/55"><Phone size={11} aria-hidden="true" />The call starts as soon as they pick up.</p>
  </main>;
}
