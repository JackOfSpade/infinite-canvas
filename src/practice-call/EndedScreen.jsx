import React from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { formatTime } from './replayModel.js';

export const ANALYSING_MESSAGE = 'Analysing the recording. Chapters, transcript and feedback appear in the hub when the analysis is ready.';

export default function EndedScreen({ state }) {
  const analysing = state?.phase === 'analyzing';
  const title = analysing ? 'Analysing the call' : 'Call ended';
  return <main className="flex min-h-screen items-center justify-center bg-[#111018] p-4 text-violet-50" aria-label={title}>
    <section className="w-full max-w-md space-y-3 rounded-xl border border-white/10 bg-[#181521] p-4">
      <h1 className="flex items-center gap-1.5 text-base font-semibold text-violet-100">{analysing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}{title}</h1>
      <p role="status" className="text-[12px] text-white/70">{analysing ? ANALYSING_MESSAGE : 'The recording is being analysed. You can close this window; the feedback is saved to your practice history.'}</p>
      <p className="flex items-center gap-1 text-[11px] text-white/50"><Clock size={11} aria-hidden="true" />Call length {formatTime(state?.elapsedMs)}</p>
      {state?.persona && <p className="text-[11px] text-white/55">Interviewer: {state.persona.name}</p>}
      {state?.error && <p role="alert" className="text-[11px] text-red-200">{state.error.message}</p>}
    </section>
  </main>;
}
