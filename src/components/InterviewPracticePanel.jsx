import React, { useCallback, useEffect, useState } from 'react';
import { Mic, Copy } from 'lucide-react';

// The hub side of practice mode: starts the Claude-chat mock interview and
// shows the written feedback that comes back through the practice connector.
const STATUS_TEXT = Object.freeze({
  armed: 'Interview in progress in your Claude chat · waiting for feedback',
  finished: 'Feedback received',
  expired: 'The last practice session expired before feedback arrived',
  cancelled: 'The last practice session was cancelled',
});
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
    {planned.length > 0 && <div><p className="text-[10px] font-semibold uppercase text-white/45">Planned questions · weakest first</p><ul className="space-y-1.5">{planned.map((item, index) => <li key={index} className="rounded-md border border-white/10 bg-black/20 p-1.5">
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
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [copied, setCopied] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  const reload = useCallback(async () => {
    if (!api?.loadInterviewPractice) return;
    try { const result = await api.loadInterviewPractice({ nodeId }); if (result && result.success !== false) setView(result); } catch { /* keep the last view */ }
  }, [api, nodeId]);
  useEffect(() => {
    const timer = setTimeout(() => { void reload(); }, 0);
    const unsubscribe = api?.onInterviewPracticeUpdated ? api.onInterviewPracticeUpdated(event => { if (event?.nodeId === nodeId) { setHistoryIndex(-1); if (event.kind === 'feedback') setNotice(null); void reload(); } }) : () => {};
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [api, nodeId, reload]);

  const start = async () => {
    if (!api?.startInterviewPractice || busy) return;
    setBusy(true); setNotice(null);
    try {
      const result = await api.startInterviewPractice({ nodeId, briefRecordId, snapshotId, canonicalJobUrl, bundleArtifactId, bundleArtifactDigest });
      if (!result || result.success === false) { setNotice({ tone: 'error', text: result?.error || 'Practice could not start.' }); return; }
      setView(result);
      setNotice(result.ok ? { tone: 'ok', text: 'Claude chat opened in Chrome with the interview set up. Pick the model you want, press Enter, then switch to voice mode and treat it like a real call. Feedback appears here when the interviewer closes the call.' } : { tone: 'error', text: result.note || 'Practice could not start.' });
    } catch (error) { setNotice({ tone: 'error', text: error?.message || 'Practice could not start.' }); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!api?.cancelInterviewPractice || busy) return;
    setBusy(true);
    try { const result = await api.cancelInterviewPractice({ nodeId }); if (result && result.success !== false) setView(result); } catch { /* status reload shows the truth */ }
    finally { setBusy(false); }
  };
  const copyUrl = async () => {
    const url = view?.bridge?.connectorUrl;
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  if (!api?.startInterviewPractice) return null;
  const bridge = view?.bridge || null;
  const session = view?.session || null;
  const history = view?.history || [];
  const shown = historyIndex >= 0 ? history[historyIndex] : view?.feedback;
  const canStart = ready && !disabled && !busy && !!bridge?.ready && session?.status !== 'armed';
  return <section className="space-y-2 border-t border-white/10 pt-3" aria-label="Practice interview">
    <p className="text-[11px] font-medium text-violet-200"><Mic size={12} className="mr-1 inline" />Practice interview</p>
    <p className="text-[11px] text-white/60">A Claude chat plays the interviewer on a virtual call: small talk, your prepared questions reworded, follow-ups and curveballs of its own. Written feedback on the whole call comes back here.</p>
    {bridge && !bridge.ready && <p role="status" className="rounded-md border border-amber-400/25 bg-amber-500/10 p-2 text-[11px] text-amber-100">{bridge.reason === 'no_hostname' ? 'Set the handoff bridge hostname in Settings; feedback arrives through it.' : 'Turn the handoff bridge on; feedback arrives through its public hostname.'}</p>}
    {bridge?.connectorUrl && <div className="rounded-md border border-white/10 bg-black/20 p-1.5 text-[10px] text-white/55">
      <p>Once, in claude.ai → Settings → Connectors → Add custom connector (no OAuth), name it “{bridge.connectorName}” with this URL:</p>
      <p className="mt-0.5 flex items-center gap-1"><code className="truncate text-white/80" title={bridge.connectorUrl}>{bridge.connectorUrl}</code><button type="button" className="nodrag rounded border border-white/10 px-1 py-0.5 text-[10px] hover:bg-white/5" onClick={copyUrl} aria-label="Copy practice connector URL"><Copy size={10} className="mr-0.5 inline" />{copied ? 'Copied' : 'Copy'}</button></p>
    </div>}
    <button type="button" className="nodrag w-full rounded-md bg-violet-500/20 px-2 py-1.5 text-xs text-violet-100 disabled:opacity-50" onClick={start} disabled={!canStart}>{busy ? 'Opening…' : session?.status === 'armed' ? 'Interview in progress' : 'Start practice interview'}</button>
    {!ready && <p className="text-[10px] text-white/45">Prepare the interview first; practice uses the prepared questions and answers.</p>}
    {session && <p role="status" className="text-[11px] text-white/70">{STATUS_TEXT[session.status] || ''}{session.status === 'armed' && <button type="button" className="ml-2 text-violet-200 underline disabled:opacity-50" onClick={cancel} disabled={busy}>Cancel</button>}</p>}
    {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className={`text-[11px] ${notice.tone === 'error' ? 'text-red-200' : 'text-emerald-100'}`}>{notice.text}</p>}
    {history.length > 0 && <label className="block text-[10px] text-white/50">Earlier feedback<select aria-label="Earlier practice feedback" className="nodrag mt-0.5 w-full rounded-md border border-white/10 bg-black/30 px-1 py-1 text-[11px]" value={historyIndex} onChange={event => setHistoryIndex(Number(event.target.value))}><option value={-1}>Latest{view?.feedback?.receivedAt ? ` · ${when(view.feedback.receivedAt)}` : ''}</option>{history.map((item, index) => <option key={index} value={index}>{when(item.receivedAt) || `Earlier ${index + 1}`}{item.overall?.score != null ? ` · ${item.overall.score}/10` : ''}</option>)}</select></label>}
    {shown ? <FeedbackView feedback={shown} /> : session?.status === 'armed' ? null : <p className="text-[10px] text-white/45">No feedback yet.</p>}
  </section>;
}

export default InterviewPracticePanel;
