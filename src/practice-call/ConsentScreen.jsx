import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { MODEL_SIZES } from './callModel.js';

export default function ConsentScreen({ onAgree, busy }) {
  return <main className="flex min-h-screen items-center justify-center bg-[#111018] p-4 text-violet-50" aria-label="Practice call setup">
    <section className="w-full max-w-md space-y-3 rounded-xl border border-white/10 bg-[#181521] p-4">
      <h1 className="text-base font-semibold text-violet-100">Practice call</h1>
      <p className="text-[12px] text-white/70">An AI interviewer calls you in this window. It hears you through the microphone on this Mac, answers in a voice you can play back, and analyses the call afterwards.</p>
      <div className="rounded-lg border border-white/10 bg-black/20 p-2">
        <p className="text-[10px] font-semibold uppercase text-white/45">Models downloaded once</p>
        <ul className="mt-1 space-y-1" aria-label="Model downloads">
          {MODEL_SIZES.map(model => <li key={model.name} className="flex items-baseline justify-between gap-2 text-[11px] text-white/75"><span>{model.name}</span><span className="text-white/50">{model.size}</span></li>)}
        </ul>
      </div>
      <p className="flex items-start gap-1.5 text-[11px] text-white/55"><ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden="true" />Recordings stay on this Mac except for the transcription request. Audio is deleted after analysis unless you keep it.</p>
      <button type="button" className="w-full rounded-md bg-violet-500/25 px-2 py-1.5 text-xs text-violet-100 hover:bg-violet-500/35 disabled:opacity-50" onClick={onAgree} disabled={!!busy}>{busy ? 'Starting…' : 'Agree and download'}</button>
    </section>
  </main>;
}
