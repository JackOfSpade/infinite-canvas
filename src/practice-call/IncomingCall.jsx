import React, { useEffect } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { startRingtone } from './ringtone.js';
import Avatar from './Avatar.jsx';
import { roleLine } from './persona.js';

export default function IncomingCall({ persona, onAnswer, onDecline }) {
  // The ring starts when the screen mounts and stops on answer, decline or
  // unmount (the effect cleanup also covers the phase change).
  useEffect(() => {
    const stop = startRingtone(typeof window === 'undefined' ? null : window);
    return stop;
  }, []);
  const name = persona?.name || 'Interviewer';
  return <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[#202124] p-4 text-violet-50" aria-label="Incoming practice call">
    <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300">Incoming practice call</p>
    <div className="flex flex-col items-center gap-2">
      <Avatar person={persona} className="h-20 w-20 text-3xl ring-4 ring-white/10" />
      <h1 className="text-lg font-semibold text-violet-50">{name}</h1>
      <p className="text-[12px] text-white/60">{roleLine(persona) || 'Interviewer'}</p>
    </div>
    <div className="flex items-center gap-8">
      <button type="button" className="flex flex-col items-center gap-1 text-[10px] text-red-200" onClick={onDecline} aria-label="Decline call">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-red-500/25 hover:bg-red-500/35"><PhoneOff size={18} aria-hidden="true" /></span>Decline
      </button>
      <button type="button" className="flex flex-col items-center gap-1 text-[10px] text-emerald-100" onClick={onAnswer} aria-label="Answer call">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-emerald-500/25 hover:bg-emerald-500/35"><Phone size={18} aria-hidden="true" /></span>Answer
      </button>
    </div>
  </main>;
}
