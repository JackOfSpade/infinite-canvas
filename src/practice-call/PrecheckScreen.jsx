import React from 'react';
import { Headphones, Mic } from 'lucide-react';
import { USAGE_WARNING, levelPercent } from './callModel.js';

export default function PrecheckScreen({ level, usageWarning, persona }) {
  const percent = levelPercent(level);
  return <main className="flex min-h-screen items-center justify-center bg-[#111018] p-4 text-violet-50" aria-label="Microphone check">
    <section className="w-full max-w-md space-y-3 rounded-xl border border-white/10 bg-[#181521] p-4">
      <h1 className="text-base font-semibold text-violet-100">Checking your audio</h1>
      <p className="text-[12px] text-white/70">{persona?.name ? `${persona.name} is about to call.` : 'The interviewer is about to call.'} Say something so the level meter moves.</p>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px] uppercase text-white/45"><span className="flex items-center gap-1"><Mic size={11} aria-hidden="true" />Microphone level</span><span>{percent}%</span></div>
        <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-emerald-300/70" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-[11px] text-white/70"><Headphones size={12} className="mt-0.5 shrink-0" aria-hidden="true" />Headphones recommended — the interviewer's voice can otherwise be picked up as if it were you.</p>
      <div role="note" aria-label="Usage warning" className="rounded-lg border border-amber-400/25 bg-amber-500/10 p-2 text-[11px] text-amber-100">{usageWarning || USAGE_WARNING}</div>
    </section>
  </main>;
}
