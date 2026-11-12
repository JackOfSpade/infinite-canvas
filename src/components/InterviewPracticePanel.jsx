import React, { useCallback, useEffect, useState } from 'react';
import { Mic } from 'lucide-react';

// The hub side of practice mode: starts the in-app local voice practice call and
// lists past calls so a recorded call can be replayed with its feedback.
const KIND_LABELS = Object.freeze({ 'small-talk': 'Small talk', curveball: 'Curveball', 'off-topic': 'Off-topic', 'follow-up': 'Follow-up', 'questions-for-interviewer': 'Your questions', closing: 'Closing', other: 'Moment' });

const scoreTone = score => (typeof score !== 'number' ? 'text-white/50' : score >= 8 ? 'text-emerald-200' : score >= 5 ? 'text-amber-100' : 'text-red-200');
const Score = ({ value }) => (typeof value === 'number' ? <span className={`text-[11px] font-semibold ${scoreTone(value)}`}>{value}/10</span> : null);
const when = iso => { const date = new Date(iso || ''); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(); };

export function FeedbackView({ feedback }) {
  if (!feedback) return null;
  const planned = [...(feedback.planned || [])].sort((a, b) => (a.asked === b.asked ? (a.score ?? 11) - (b.score ?? 11) : a.asked ? -1 : 1));
  const communication = Object.entries(feedback.communication || {}).filter(([, text]) => text);
  return <div className="space-y-2" data-testid="practice-feedback">
    <p className="text-xs text-white/80"><span className="font-semibold">Overall</span> <Score value={feedback.overall?.score} />{feedback.receivedAt ? <span className="text-[10px] text-white/45"> · {when(feedback.receivedAt)}</span> : null}</p>
    <p className="text-[11px] text-white/75 whitespace-pre-wrap">{feedback.overall?.summary}</p>
    {feedback.priorities?.length > 0 && <div><p className="text-[10px] font-semibold uppercase text-white/45">Work on first</p><ol className="list-decimal pl-4 text-[11px] text-amber-100 space-y-0.5">{feedback.priorities.map((item, index) => <li key={index}>{item}</li>)}</ol></div>}
    {planned.length > 0 && <div><p className="text-[10px] font-semibold uppercase text-white/45">Planned questions · weakest first</p><ul className="space-y-1.5">{planned.map((item, index) => <li key={index} className="break-inside-avoid rounded-md border border-white/10 bg-black/20 p-1.5">
      <p className="text-[11px] text-white/85"><Score value={item.score} /> {item.score != null ? '· ' : ''}{item.question}{!item.asked && <span className="text-white/45"> · not asked</span>}</p>
      {item.askedAs && <p className="text-[10px] text-white/55">Asked as: {item.askedAs}</p>}
      <section className="practice-memorized" aria-label="Memorized answer"><p className="text-[10px] font-semibold uppercase text-white/40">Memorized answer</p>
        {item.covered && <p className="text-[11px] text-white/70">{item.covered}</p>}
        {item.adapted && <p className="text-[11px] text-white/70">Adapting: {item.adapted}</p>}
        {item.improve && <p className="text-[11px] text-amber-100">Practice: {item.improve}</p>}
        {!item.covered && !item.adapted && !item.improve && <p className="text-[11px] text-white/45">No notes.</p>}</section>
      {item.extension && <details className="practice-extension text-[11px] text-white/60"><summary className="cursor-pointer">Optional extension</summary>
        <p className="text-[10px] text-white/45">Say this only if you can back it with a real example.</p>
        <p>{item.extension}</p></details>}
    </li>)}</ul></div>}
    {feedback.moments?.length > 0 && <div><p className="text-[10px] font-semibold uppercase text-white/45">Rest of the call</p><ul className="space-y-1">{feedback.moments.map((item, index) => <li key={index} className="text-[11px] text-white/75"><span className="text-violet-200">{KIND_LABELS[item.kind] || item.kind}</span> <Score value={item.score} /> · {item.prompt}{item.note ? <span className="text-white/60"> — {item.note}</span> : null}</li>)}</ul></div>}
    {communication.length > 0 && <div><p className="text-[10px] font-semibold uppercase text-white/45">Communication</p><ul className="space-y-0.5">{communication.map(([key, text]) => <li key={key} className="text-[11px] text-white/75"><span className="capitalize text-violet-200">{key}</span>: {text}</li>)}</ul></div>}
    {feedback.transcript?.length > 0 && <details className="text-[11px]"><summary className="cursor-pointer text-white/55">Transcript · {feedback.transcript.length} turns</summary><ol className="mt-1 max-h-64 space-y-1 overflow-y-auto">{feedback.transcript.map((turn, index) => <li key={index} className={turn.role === 'candidate' ? 'text-white/85' : 'text-white/60'}><span className="font-semibold">{turn.role === 'candidate' ? 'You' : 'Interviewer'}:</span> {turn.text}</li>)}</ol></details>}
  </div>;
}

export function InterviewPracticePanel({ nodeId, briefRecordId, snapshotId, canonicalJobUrl, bundleArtifactId, bundleArtifactDigest, ready, disabled }) {
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [pastCalls, setPastCalls] = useState([]);
  const [pastNotice, setPastNotice] = useState(null);
  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  // Past practice calls are local: list them whenever the hub mounts (and after
  // a call finishes) so a replay opens without leaving this panel.
  const loadPastCalls = useCallback(async () => {
    if (typeof api?.listPracticeCalls !== 'function') return;
    try {
      const result = await api.listPracticeCalls({ nodeId });
      const calls = Array.isArray(result) ? result : Array.isArray(result?.calls) ? result.calls : [];
      setPastCalls(calls);
    } catch { /* keep the last list */ }
  }, [api, nodeId]);
  const pastCallsReady = typeof api?.listPracticeCalls === 'function';
  useEffect(() => {
    if (!pastCallsReady) return undefined;
    const timer = setTimeout(() => { void loadPastCalls(); }, 0);
    const unsubscribe = typeof api.onPracticeCallUpdated === 'function' ? api.onPracticeCallUpdated(event => { if (!event || !event.nodeId || event.nodeId === nodeId) void loadPastCalls(); }) : null;
    const onFocus = () => { void loadPastCalls(); };
    window.addEventListener('focus', onFocus);
    return () => { clearTimeout(timer); if (typeof unsubscribe === 'function') unsubscribe(); window.removeEventListener('focus', onFocus); };
  }, [api, nodeId, pastCallsReady, loadPastCalls]);
  const startCall = async () => {
    if (typeof api?.startPracticeCall !== 'function' || practiceBusy) return;
    setPracticeBusy(true);
    setPastNotice(null);
    try {
      const result = await api.startPracticeCall({ nodeId, briefRecordId, snapshotId, canonicalJobUrl, bundleArtifactId, bundleArtifactDigest });
      if (result && result.success === false) setPastNotice({ tone: 'error', text: result.error || 'The practice call could not start.' });
      else if (result?.note) setPastNotice({ tone: 'error', text: result.note });
    } catch (error) { setPastNotice({ tone: 'error', text: error?.message || 'The practice call could not start.' }); }
    finally { setPracticeBusy(false); }
  };
  const openReplay = async callId => {
    if (typeof api?.openPracticeReplay !== 'function' || !callId) return;
    try {
      const result = await api.openPracticeReplay({ nodeId, callId });
      if (result && result.success === false) setPastNotice({ tone: 'error', text: result.error || 'The replay could not open.' });
    } catch (error) { setPastNotice({ tone: 'error', text: error?.message || 'The replay could not open.' }); }
  };

  // The in-app call is the only practice path; without it the panel has nothing to show.
  if (typeof api?.startPracticeCall !== 'function') return null;
  const canCall = ready && !disabled && !practiceBusy;
  const durationLabel = ms => { const total = Math.max(0, Math.round((Number(ms) || 0) / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };
  return <section className="space-y-2 border-t border-white/10 pt-3" aria-label="Practice interview">
    <p className="text-[11px] font-medium text-violet-200"><Mic size={12} className="mr-1 inline" />Practice interview</p>
    <p className="text-[11px] text-white/60">An AI interviewer calls you inside the app: small talk, your prepared questions reworded, follow-ups and curveballs. Answer out loud, or type in the call's chat — typed answers are heard as if you said them. Feedback on the whole call comes with the replay.</p>
    <div className="space-y-1.5 rounded-md border border-white/10 bg-black/20 p-2" aria-label="Practice call">
      <button type="button" className="nodrag w-full rounded-md bg-violet-500/30 px-2 py-1.5 text-xs text-violet-50 disabled:opacity-50" onClick={startCall} disabled={!canCall}>{practiceBusy ? 'Starting…' : 'Start practice call'}</button>
      {!ready && <p className="text-[10px] text-white/45">Prepare the interview first; the call uses the prepared questions and answers.</p>}
      <div aria-label="Past calls">
        <p className="text-[10px] font-semibold uppercase text-white/45">Past calls</p>
        {pastCalls.length === 0 ? <p className="text-[10px] text-white/40">No past calls yet.</p> : <ul className="mt-0.5 space-y-0.5">{pastCalls.map(call => {
          const id = call?.callId || call?.id;
          const label = `${when(call?.startedAt) || 'Undated call'} · ${durationLabel(call?.durationMs)} · ${call?.persona?.name || 'Interviewer'}`;
          return <li key={id || label} className="flex items-center justify-between gap-2 text-[11px] text-white/70">
            <span className="min-w-0 truncate">{label}</span>
            <button type="button" className="nodrag rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-violet-200 hover:bg-white/5 disabled:opacity-40" onClick={() => openReplay(id)} disabled={!id} aria-label={`Replay ${call?.persona?.name || 'practice'} call from ${when(call?.startedAt) || 'unknown date'}`}>Replay</button>
          </li>;
        })}</ul>}
      </div>
      {pastNotice && <p role={pastNotice.tone === 'error' ? 'alert' : 'status'} className={`text-[11px] ${pastNotice.tone === 'error' ? 'text-red-200' : 'text-emerald-100'}`}>{pastNotice.text}</p>}
    </div>
  </section>;
}

export default InterviewPracticePanel;
