import React, { useEffect, useState } from 'react';
import './interviewWindow.css';
import { interviewSubmitErrorMessage, SESSION_ENDED_MESSAGE } from './submitError.js';

const componentLabels = { decision: 'decision/trade-off', outcome: 'outcome', lesson: 'lesson learned' };

function List({ title, items }) {
  if (!Array.isArray(items) || !items.length) return null;
  return <section><h3>{title}</h3><ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul></section>;
}

function ResearchCitations({ sources }) {
  if (!Array.isArray(sources) || !sources.length) return null;
  return <section className="interview-citations" aria-label="Research citations"><h3>Research citations</h3><ul>{sources.map((source, index) => (
    <li key={`citation-${index}`}><span className="citation-url" dir="ltr">{source.sourceUrl}</span><span className="citation-date">Source date: {source.sourceDate}</span></li>
  ))}</ul></section>;
}

function Briefing({ briefing }) {
  if (!briefing) return null;
  const role = briefing.role || {};
  return <details className="interview-briefing"><summary>Job briefing & reference</summary>
    <section><h3>Role</h3><p>{role.title || 'Not provided'}{role.company ? ` · ${role.company}` : ''}{role.location ? ` · ${role.location}` : ''}</p>{role.summary && <p>{role.summary}</p>}</section>
    <List title="Role themes" items={briefing.roleThemes} />
    <List title="Company" items={briefing.companyFacts} />
    <List title="Recent context" items={briefing.recentContext} />
    <List title="Likely questions" items={briefing.likelyQuestions} />
    <List title="Questions to ask" items={briefing.questionsToAsk} />
    <List title="Application positioning" items={briefing.applicationPositioning} />
    <List title="Source warnings" items={briefing.warnings} />
    <ResearchCitations sources={briefing.sources} />
  </details>;
}

export function InterviewWindowApp() {
  const [brief, setBrief] = useState(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [loadingFailed, setLoadingFailed] = useState(false);
  const plan = brief?.plan || null;
  const [step, setStep] = useState(0);

  useEffect(() => {
    let active = true;
    const api = window.interviewAPI;
    if (!api) return undefined;
    const load = () => api.getBrief().then(value => {
      if (!active) return;
      setBrief(value);
      setStep(value?.plan?.currentStep || 0);
      // Main owns the native pin; a reloaded page restores its checkbox from it.
      setAlwaysOnTop(value?.alwaysOnTop === true);
      setLoadingFailed(!value);
    }).catch(() => { if (active) { setLoadingFailed(true); setError('The interview window could not load its prepared brief.'); } });
    load();
    const cleanup = api.onBriefUpdated(value => { if (active) { setBrief(value); setStep(value?.plan?.currentStep || 0); setError(''); } });
    return () => { active = false; cleanup?.(); };
  }, []);

  const retryLoad = () => window.interviewAPI.getBrief().then(value => { setBrief(value); setStep(value?.plan?.currentStep || 0); setAlwaysOnTop(value?.alwaysOnTop === true); setLoadingFailed(!value); if (value) setError(''); }).catch(() => { setLoadingFailed(true); setError('The interview window could not load its prepared brief.'); });

  useEffect(() => {
    const keydown = event => {
      // Only a supported rail has steps to move through; otherwise leave the
      // arrow keys to scroll the briefing.
      if (plan?.status !== 'supported' || !plan.steps?.length || event.target?.matches?.('textarea,input')) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); setStep(value => Math.min(value + 1, plan.steps.length - 1)); }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); setStep(value => Math.max(value - 1, 0)); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [plan]);

  const submit = async event => {
    event.preventDefault();
    try {
      setError('');
      // The main process also publishes this display over its update event,
      // but applying the invoke result keeps the child correct if that event
      // is delayed or coalesced during navigation.
      const updated = await window.interviewAPI.submitQuestion(question);
      setBrief(updated);
      setStep(updated?.plan?.currentStep || 0);
    } catch (failure) { setError(interviewSubmitErrorMessage(failure)); }
  };
  const nextQuestion = async () => {
    try {
      const updated = await window.interviewAPI.nextQuestion();
      // Main answers null when this child has no session any more. Show the
      // missing-brief alert (Retry/Close) instead of loading forever.
      if (!updated) { setBrief(null); setLoadingFailed(true); setError(SESSION_ENDED_MESSAGE); return; }
      setBrief(updated); setQuestion(''); setStep(0); setError('');
    } catch { setError('The interview session could not advance to the next question.'); }
  };
  const toggleAlwaysOnTop = async event => {
    const value = event.target.checked;
    setAlwaysOnTop(value);
    // Main answers true only when it applied the change; otherwise show the state the window is really in.
    try { if ((await window.interviewAPI.setAlwaysOnTop(value)) !== true) setAlwaysOnTop(!value); } catch { setAlwaysOnTop(!value); }
  };
  const active = plan?.steps?.[step] || null;

  return <main className="interview-window" aria-live="polite">
    <header><div><p className="eyebrow">Interview companion</p><h1>Saved evidence, not a script</h1></div><button type="button" onClick={() => window.interviewAPI.close()}>Close</button></header>
    {!brief && !loadingFailed && <p>Loading prepared brief…</p>}
    {!brief && loadingFailed && <section className="interview-load-error" role="alert"><p>{error || 'The interview window could not load its prepared brief.'}</p><button type="button" onClick={retryLoad}>Retry</button><button type="button" onClick={() => window.interviewAPI.close()}>Close</button></section>}
    {brief && !plan && <form onSubmit={submit}><label htmlFor="interview-question">Current question</label><textarea id="interview-question" value={question} onChange={event => setQuestion(event.target.value)} placeholder="Type or paste the interviewer’s question" maxLength="2000" autoFocus /><button type="submit">Find saved evidence</button>{error && <p role="alert">{error}</p>}</form>}
    {brief && plan && error && <p className="interview-warning" role="alert">{error}</p>}
    {brief && plan?.status === 'unsupported' && <section className="interview-warning" role="status"><p>{plan.message}</p><button type="button" onClick={nextQuestion}>Enter another question</button></section>}
    {brief && plan?.status === 'supported' && <>
      <section className="locked-question"><p className="eyebrow">Locked question</p><p>{plan.question}</p></section>
      {plan.message && <p className="interview-plan-note" role="status">{plan.message}</p>}
      <ol className="evidence-rail" aria-label="Saved evidence rail">{plan.steps.slice(0, 6).map((item, index) => <li key={item.id} aria-current={index === step ? 'step' : undefined} data-rail-state={index < step ? 'completed' : index === step ? 'current' : 'upcoming'}><button type="button" onClick={() => setStep(index)}><span>{index + 1}</span><strong>{item.label}</strong><em>{item.cue}</em><small>{item.roleAttribution}</small></button></li>)}</ol>
      {active && <section className="evidence-card"><p className="eyebrow">{active.label}</p><p>{active.cue}</p>{active.roleAttribution && <small>{active.roleAttribution}</small>}</section>}
      {plan.missingComponents?.length > 0 && <p className="interview-warning" role="status">Saved evidence does not document: {plan.missingComponents.map(item => componentLabels[item] || item).join(', ')}. Do not fill that gap from this rail.</p>}
      <nav aria-label="Evidence controls"><button type="button" onClick={() => setStep(value => Math.max(0, value - 1))} disabled={step === 0}>Previous</button><button type="button" onClick={() => setStep(value => Math.min(plan.steps.length - 1, value + 1))} disabled={step === plan.steps.length - 1}>Next</button><button type="button" onClick={nextQuestion}>Next question</button></nav>
      <p className="next-note">Next question clears this marker so you can type or paste the next interviewer question here.</p>
    </>}
    <Briefing briefing={brief?.briefing} />
    <label className="pin"><input type="checkbox" checked={alwaysOnTop} onChange={toggleAlwaysOnTop} /> Keep this window on top</label>
  </main>;
}

export default InterviewWindowApp;
