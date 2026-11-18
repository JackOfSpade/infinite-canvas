import React from 'react';
import { Check, Loader2 } from 'lucide-react';
import { ANALYSIS_STAGES, analysisStageIndex } from './callModel.js';
import Avatar from './Avatar.jsx';
import { formatTime } from './replayModel.js';

export const ANALYSING_MESSAGE = 'Analysing the recording. Your feedback opens in this window as soon as it is ready.';

// Shown from hang-up until the review is written: the call UI is gone and the
// steps of the post-call processing tick off in place.
export default function EndedScreen({ state }) {
  // Leaving without feedback only saves the recording: one step, no review.
  const skipped = state?.feedbackRequested === false;
  const analysing = state?.phase === 'analyzing' && !skipped;
  const stages = skipped ? ANALYSIS_STAGES.slice(0, 1) : ANALYSIS_STAGES;
  const title = analysing ? 'Analysing the call' : 'Call ended';
  const active = analysing ? analysisStageIndex(state?.analysisStage) : -1;
  return <main className="flex min-h-screen items-center justify-center bg-[#202124] p-6 text-[#e8eaed]" aria-label={title}>
    <section className="pc-rise w-full max-w-md space-y-5">
      <div className="flex items-center gap-4">
        <Avatar person={state?.persona} className="h-14 w-14 text-xl"><span className="pc-ring absolute inset-0 rounded-full" /></Avatar>
        <div className="min-w-0">
          <h1 className="text-2xl font-normal text-white">{analysing ? 'Preparing your feedback' : 'You left the call'}</h1>
          <p className="text-sm text-[#9aa0a6]">Call length {formatTime(state?.elapsedMs)}{state?.persona?.name ? ` · Interviewer: ${state.persona.name}` : ''}</p>
        </div>
      </div>
      <div className="relative h-1 overflow-hidden rounded-full bg-white/10" aria-hidden="true"><span className="pc-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-[#8ab4f8]" /></div>
      <ol aria-label="Processing steps" className="space-y-2.5">
        {stages.map((stage, index) => {
          const status = index < active ? 'done' : index === active || (active < 0 && index === 0) ? 'active' : 'pending';
          return <li key={stage.key} data-stage={stage.key} data-status={status} aria-current={status === 'active' ? 'step' : undefined}
            className={`flex items-center gap-3 text-sm transition-colors duration-300 ${status === 'pending' ? 'text-[#5f6368]' : status === 'done' ? 'text-[#9aa0a6]' : 'text-white'}`}>
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full transition-colors duration-300 ${status === 'done' ? 'bg-[#81c995] text-[#202124]' : status === 'active' ? 'bg-[#8ab4f8]/20 text-[#8ab4f8]' : 'border border-[#5f6368]'}`} aria-hidden="true">
              {status === 'done' ? <Check size={14} className="pc-pop" /> : status === 'active' ? <Loader2 size={14} className="animate-spin" /> : null}
            </span>
            {stage.label}
          </li>;
        })}
      </ol>
      <p role="status" className="text-sm text-[#9aa0a6]">{analysing ? ANALYSING_MESSAGE : skipped ? 'Call ended. The recording is being saved; no feedback is generated.' : 'Call ended. The recording is being analysed and your feedback opens here next.'}</p>
      {state?.error && <p role="alert" className="pc-fade rounded-lg bg-[#3c4043] px-3 py-2 text-sm text-[#f28b82]">{state.error.message}</p>}
    </section>
  </main>;
}
