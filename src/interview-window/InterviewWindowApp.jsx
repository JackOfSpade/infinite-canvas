import React, { useCallback, useEffect, useRef, useState } from 'react';
import './interviewWindow.css';
import { interviewIgnoredMessage, interviewSubmitErrorMessage, SESSION_ENDED_MESSAGE } from './submitError.js';
import CallAudioPanel from './CallAudioPanel.jsx';
import ComingUp from './ComingUp.jsx';
import { InterviewQaBadges } from '../components/InterviewQaBadges';

function hasPreparedAnswer(card) {
  return card && !['needs-prep', 'empty'].includes(card.status) && Boolean(card.headline?.trim() || card.bullets?.some(item => item.text?.trim()) || (typeof card.example === 'string' ? card.example.trim() : card.example?.text?.trim()));
}

function normalizeAnswerCard(card) {
  return { ...card, bullets: card.bullets || [], example: typeof card.example === 'string' ? { text: card.example, evidenceIds: [] } : card.example || { text: '', evidenceIds: [] }, evidence: card.evidence || [], optionalExtension: card.optionalExtension || card.extensions || [] };
}

function PreparedQuestionGroups({ cards, company, selectedId, onSelect }) {
  return [['foundation', 'Foundation'], ['company', company || 'Company']].map(([scope, label]) => {
    const group = cards.filter(card => (card.scope || 'company') === scope);
    return group.length > 0 && <section className="prepared-question-group" aria-label={`${label} questions`} key={scope}>
      <h4>{label}</h4>
      <div className="prepared-question-options">{group.map(card => <button key={card.id} type="button" aria-pressed={selectedId === card.id} onClick={() => onSelect(card)}>
        <span>{card.question}</span>{card.origin === 'disclosed' && <span className="question-disclosed">Disclosed</span>}
        {['needs-prep', 'empty'].includes(card.status) && <small>{card.status === 'needs-prep' ? 'Needs prep' : 'Empty'}</small>}
      </button>)}</div>
    </section>;
  });
}

const componentLabels = { decision: 'decision/trade-off', outcome: 'outcome', lesson: 'lesson learned' };
const LOAD_FAILED_MESSAGE = 'The interview window could not load its prepared brief. Retry, or close this window and launch it again from the Interview Helper.';
const EXTENSION_CAUTION = 'Optional, bring in only if you can back it with an example';
const followUpContextKey = display => JSON.stringify([display?.answerCard?.id || null,
  display?.question || display?.plan?.question || display?.answerCard?.question || '']);

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

const answerStageLabels = { situation: 'Situation', task: 'Task', action: 'Action', result: 'Result', reflection: 'Reflection' };

function AnswerCitations({ evidenceIds, sourceNumbers, showSource }) {
  return <span className="answer-citation-refs">{(evidenceIds || []).filter(id => sourceNumbers.has(id)).map(id => <button key={id} type="button" className="answer-citation-ref" onClick={() => showSource(id)} aria-label={`Show exact cited evidence ${sourceNumbers.get(id)}`}>[{sourceNumbers.get(id)}]</button>)}</span>;
}

function PreparedAnswer({ card: rawCard, headingRef, mode = 'recall', provisionalConfidence }) {
  const evidenceDetails = useRef(null);
  const sourceItems = useRef(new Map());
  const card = normalizeAnswerCard(rawCard);
  if (!hasPreparedAnswer(rawCard)) {
    return <section className="spoken-answer no-prepared-answer" aria-label="Prepared spoken answer">
      <p className="eyebrow">Your prepared answer</p>
      <h2 ref={headingRef} tabIndex={-1}>{card.question}</h2>
      <InterviewQaBadges card={card} />
      <p className="no-answer-text" role="status">No prepared answer yet</p>
      <p className="keyboard-help">Answer in your own words. Add an answer in Edit Q&A before your next interview.</p>
    </section>;
  }
  const sourceNumbers = new Map(card.evidence.map((item, index) => [item.id, index + 1]));
  const showSource = id => {
    if (evidenceDetails.current) evidenceDetails.current.open = true;
    sourceItems.current.get(id)?.focus();
  };
  const citations = ids => <AnswerCitations evidenceIds={ids} sourceNumbers={sourceNumbers} showSource={showSource} />;
  // Continuation mode keeps the memorized material intact, but puts the next
  // useful action/outcome ahead of background while the person is speaking.
  const continuation = mode === 'continuation';
  const priority = { action: 0, result: 1, point: 2, reflection: 3, task: 4, situation: 5 };
  const bullets = continuation ? card.bullets.map((bullet, index) => ({ bullet, index }))
    .sort((left, right) => (priority[left.bullet.stage] ?? 2) - (priority[right.bullet.stage] ?? 2) || left.index - right.index)
    .map(item => item.bullet) : card.bullets;
  const extensions = Array.isArray(card.optionalExtension) ? card.optionalExtension : [];
  const provisional = typeof provisionalConfidence === 'number';
  return <section className={`spoken-answer${continuation ? ' continuation-answer' : ''}${provisional ? ' provisional-answer' : ''}`} aria-label="Prepared spoken answer" data-answer-layout={mode}>
    <section className="prepared-answer-recall" aria-label="Your prepared answer">
    <p className="eyebrow" ref={continuation ? headingRef : undefined} tabIndex={continuation ? -1 : undefined}>Your prepared answer{provisional && <span className="preview-badge">Likely · {Math.round(provisionalConfidence * 100)}%</span>}</p>
    {continuation && <p className="continuation-guidance">Keep going in your own words. Glance at a cue when ready.</p>}
    {card.thinEvidence && <p className="answer-thin-evidence" role="status">Thin evidence</p>}
    <h2 ref={continuation ? undefined : headingRef} tabIndex={-1}><span className="answer-headline-text" key={card.id}>{card.headline}</span>{citations(card.headlineEvidenceIds)}</h2>
    <ul className="spoken-bullets">{bullets.map((bullet, index) => <li key={index}>{answerStageLabels[bullet.stage] && <span className="answer-stage">{answerStageLabels[bullet.stage]}</span>}<span>{bullet.text}</span>{citations(bullet.evidenceIds)}</li>)}</ul>
    <details className="spoken-example"><summary>Concrete example</summary><p>{card.example.text}{citations(card.example.evidenceIds)}</p></details>
    </section>
    {extensions.length > 0 && <details className="optional-extension" aria-label="Optional extension"><summary>Optional extension</summary>
    <p className="extension-caution">{EXTENSION_CAUTION}</p>
    <ul className="extension-points">{extensions.map((point, index) => <li key={point.id || index}><span>{point.text}</span>{citations(point.evidenceIds)}{point.exampleHook && <small className="extension-example-hook">Example hook: {point.exampleHook}</small>}</li>)}</ul>
    </details>}
    <details className="answer-evidence" ref={evidenceDetails}><summary>Exact cited evidence</summary><ol>{card.evidence.map((item, index) => <li key={item.id} tabIndex={-1} data-citation-number={index + 1} ref={element => { if (element) sourceItems.current.set(item.id, element); else sourceItems.current.delete(item.id); }}><small>{item.sourceLabel}</small><blockquote>{item.quote}</blockquote></li>)}</ol></details>
    {card.consistency && <details className="answer-consistency"><summary>{card.consistency.consistentWithResume ? 'Consistent with submitted résumé · cited wording' : 'Submitted résumé consistency is unconfirmed'}</summary>{card.consistency.resumeQuote && <blockquote>{card.consistency.resumeQuote}</blockquote>}<p>Checks the cited wording. This is not a review of every résumé claim.</p></details>}
  </section>;
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
    <List title="Submitted application wording — reference, not career evidence" items={briefing.applicationPositioning} />
    <p className="keyboard-help">Confirm this career source matches the application you submitted. Replace the bundle after editing its documents.</p>
    <List title="Source warnings" items={briefing.warnings} />
    <ResearchCitations sources={briefing.sources} />
  </details>;
}

// Everything but the speculative preview and matching/layout state, in a
// key-order-independent form (a spread may move an absent key to the end).
const displayIdentity = state => JSON.stringify(Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'preview' && key !== 'matching')));

export function InterviewWindowApp() {
  const [brief, setBrief] = useState(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [errorTarget, setErrorTarget] = useState(null);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const [followUpNotice, setFollowUpNotice] = useState('');
  const followUpContext = useRef(null);
  const displayedBrief = useRef(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [typedDraft, setTypedDraft] = useState('');
  const busy = useRef(false);
  const requestSequence = useRef(0);
  const retryInput = useRef(null);
  const questionInput = useRef(null);
  const typedDraftInput = useRef(null);
  const restoreTypedDraftFocus = useRef(false);
  const followUpInput = useRef(null);
  const answerHeading = useRef(null);
  const unsupportedEdit = useRef(null);
  const plan = brief?.plan || null;
  const answerCard = brief?.answerCard || null;
  const hasResponse = !!answerCard || !!plan;
  const supported = !!answerCard || plan?.status === 'supported';
  const preparedCards = brief?.briefing?.preparedCards || [];
  const scopedQuestions = preparedCards.some(card => card.scope === 'foundation' || card.scope === 'company');
  const hasPreparedAnswers = preparedCards.length > 0 || !!brief?.briefing?.preparedQuestions?.length;
  const likelyQuestions = brief?.briefing?.likelyQuestions || [];
  const [step, setStep] = useState(0);

  const [answerRevision, setAnswerRevision] = useState(0);
  const [previewAnnouncement, setPreviewAnnouncement] = useState('');
  const lastFocusContext = useRef(null);
  const preservePromotionFocus = useRef(false);
  const preview = brief?.preview || null;
  const mainCard = answerCard || preview?.card || null;
  const comingUp = answerCard && preview?.cardId !== answerCard.id ? preview : null;

  const receiveDisplay = useCallback(value => {
    const previous = displayedBrief.current;
    const previousCardId = previous?.answerCard?.id || previous?.preview?.cardId;
    const nextCardId = value?.answerCard?.id || value?.preview?.cardId;
    if (!previous?.answerCard && previous?.preview && previous.preview.cardId === value?.answerCard?.id) preservePromotionFocus.current = true;
    // Keep disclosure controls mounted through speculative switches as well as
    // same-card promotion, so a keyboard reader never loses a focused summary.
    // A genuinely new locked question still starts collapsed.
    const switchingPreview = !previous?.answerCard && previous?.preview && !value?.answerCard && value?.preview;
    if ((!switchingPreview && previousCardId !== nextCardId) || (previous?.answerCard && value?.answerCard && followUpContextKey(previous) !== followUpContextKey(value))) {
      setAnswerRevision(revision => revision + 1);
    }
    const visiblePreview = value?.preview?.cardId !== value?.answerCard?.id ? value?.preview : null;
    const previousPreview = previous?.preview?.cardId !== previous?.answerCard?.id ? previous?.preview : null;
    if (visiblePreview?.cardId !== previousPreview?.cardId) {
      setPreviewAnnouncement(visiblePreview ? `${value?.answerCard ? 'Coming up' : 'Likely prepared answer'}: ${visiblePreview.card.headline}. Provisional answer.` : '');
    }
    displayedBrief.current = value;
    setBrief(value);
    // Confidence/transcript ticks and matching/layout changes are not new
    // answers. In particular, do not reset cue navigation, feedback or any
    // in-progress forms for these events.
    if (previous && value && displayIdentity(previous) === displayIdentity(value)) return;
    // A follow-up draft belongs to the answer on which it was opened. Keep
    // its text, but require reopening it explicitly after the story changes.
    if (followUpContext.current && followUpContext.current !== followUpContextKey(value)) {
      followUpContext.current = null;
      setFollowUpOpen(false);
      setFollowUpNotice('The question changed. Your follow-up draft is saved. Choose Follow-up to review it for the current answer.');
    }
    // Listening can find an answer while the user is still typing a question.
    if (!busy.current && (value?.answerCard || value?.plan) && questionInput.current?.value) {
      setTypedDraft(questionInput.current.value);
      restoreTypedDraftFocus.current = document.activeElement === questionInput.current;
    }
    setStep(value?.plan?.currentStep || 0); setCopyStatus('');
    if (value) { setError(''); setErrorTarget(null); }
  }, []);

  useEffect(() => {
    let active = true;
    const api = window.interviewAPI;
    if (!api) {
      Promise.resolve().then(() => { if (active) { setLoadingFailed(true); setError(LOAD_FAILED_MESSAGE); } });
      return () => { active = false; };
    }
    const load = () => api.getBrief().then(value => {
      if (!active) return;
      receiveDisplay(value);
      // Main owns the native pin; a reloaded page restores its checkbox from it.
      setAlwaysOnTop(value?.alwaysOnTop === true);
      setLoadingFailed(!value);
    }).catch(() => { if (active) { setLoadingFailed(true); setError(LOAD_FAILED_MESSAGE); } });
    load();
    const cleanup = api.onBriefUpdated(value => { if (active) {
      receiveDisplay(value);
    } });
    return () => { active = false; cleanup?.(); };
  }, [receiveDisplay]);

  const retryLoad = () => Promise.resolve().then(() => window.interviewAPI.getBrief()).then(value => { receiveDisplay(value); setAlwaysOnTop(value?.alwaysOnTop === true); setLoadingFailed(!value); }).catch(() => { setLoadingFailed(true); setError(LOAD_FAILED_MESSAGE); });

  useEffect(() => {
    // A cloned display on each speculative tick must not refocus a heading
    // (which can also scroll it into view) or interrupt a reader's controls.
    const context = JSON.stringify([!!brief, followUpContextKey(brief), plan?.status, plan?.currentStep, pending, followUpOpen]);
    if (lastFocusContext.current === context) return;
    lastFocusContext.current = context;
    if (pending) return;
    const promoted = preservePromotionFocus.current;
    preservePromotionFocus.current = false;
    if (restoreTypedDraftFocus.current && typedDraftInput.current) { typedDraftInput.current.focus(); restoreTypedDraftFocus.current = false; return; }
    if (promoted) return;
    if (brief && !hasResponse && !brief.preview) questionInput.current?.focus();
    // An automatic card must not pull focus away from a question being typed.
    const editing = document.activeElement?.matches?.('textarea,input,select,[contenteditable="true"]');
    if (supported && !followUpOpen && !editing) answerHeading.current?.focus();
    if (!answerCard && plan?.status === 'unsupported' && !editing) unsupportedEdit.current?.focus();
  }, [brief, plan, answerCard, hasResponse, supported, pending, followUpOpen]);
  useEffect(() => { if (followUpOpen) followUpInput.current?.focus(); }, [followUpOpen]);
  useEffect(() => {
    // A rejected request restores focus only after React re-enables the input.
    // The request counter also handles immediately repeated identical errors.
    if (!pending) { retryInput.current?.focus(); retryInput.current = null; }
  }, [pending, focusRequest]);

  const submitQuestion = async (value, isFollowUp = false, replaceCurrent = false) => {
    // The ref also covers two Enter presses before React commits the pending state.
    if (busy.current) return;
    const sequence = ++requestSequence.current;
    busy.current = true; retryInput.current = null; setPending(true); if (!isFollowUp) setQuestion(value); setCopyStatus('');
    try {
      setError(''); setErrorTarget(isFollowUp ? 'followUp' : replaceCurrent ? 'replacement' : 'question');
      // The main process also publishes this display over its update event,
      // but applying the invoke result keeps the child correct if that event
      // is delayed or coalesced during navigation.
      const updated = await (isFollowUp ? window.interviewAPI.followUpQuestion(value) : window.interviewAPI.submitQuestion(value));
      if (sequence !== requestSequence.current) return;
      if (!updated) { setBrief(null); setLoadingFailed(true); setError(SESSION_ENDED_MESSAGE); return; }
      if (updated.ignored) {
        setError(interviewIgnoredMessage(updated)); setErrorTarget(isFollowUp ? 'followUp' : replaceCurrent ? 'replacement' : 'question');
        retryInput.current = (isFollowUp ? followUpInput : replaceCurrent ? typedDraftInput : questionInput).current;
        setFocusRequest(value => value + 1);
        return;
      }
      receiveDisplay(updated);
      if (replaceCurrent) setTypedDraft('');
      if (isFollowUp) { followUpContext.current = null; setFollowUpOpen(false); setFollowUp(''); setFollowUpNotice(''); }
    } catch (failure) { if (sequence === requestSequence.current) { setError(interviewSubmitErrorMessage(failure)); setErrorTarget(isFollowUp ? 'followUp' : replaceCurrent ? 'replacement' : 'question'); retryInput.current = (isFollowUp ? followUpInput : replaceCurrent && typedDraftInput.current ? typedDraftInput : questionInput).current; setFocusRequest(value => value + 1); } }
    finally { if (sequence === requestSequence.current) { busy.current = false; setPending(false); } }
  };
  const selectPreparedCard = async card => {
    // An explicit choice can supersede a slow semantic request immediately.
    const sequence = ++requestSequence.current;
    busy.current = true; retryInput.current = null; setPending(true); setError(''); setErrorTarget(null); setCopyStatus('');
    try {
      const updated = await window.interviewAPI.selectPreparedCard(card.id);
      if (sequence !== requestSequence.current) return;
      if (!updated) { setBrief(null); setLoadingFailed(true); setError(SESSION_ENDED_MESSAGE); return; }
      receiveDisplay(updated); setQuestion(card.question); setFollowUpOpen(false); setFollowUp(''); setFollowUpNotice(''); followUpContext.current = null;
    } catch (failure) { if (sequence === requestSequence.current) setError(interviewSubmitErrorMessage(failure)); }
    finally { if (sequence === requestSequence.current) { busy.current = false; setPending(false); } }
  };
  const submit = event => { event.preventDefault(); void submitQuestion(question); };
  const nextQuestion = async (preserveQuestion = false) => {
    if (busy.current) return;
    const sequence = ++requestSequence.current;
    busy.current = true; setPending(true); setErrorTarget(null);
    try {
      const updated = await window.interviewAPI.nextQuestion();
      if (sequence !== requestSequence.current) return;
      // Main answers null when this child has no session any more. Show the
      // missing-brief alert (Retry/Close) instead of loading forever.
      if (!updated) { setBrief(null); setLoadingFailed(true); setError(SESSION_ENDED_MESSAGE); return; }
      receiveDisplay(updated); setQuestion(preserveQuestion ? brief?.question || plan?.question || question || answerCard?.question || '' : ''); setStep(0); setFollowUpOpen(false); setFollowUp(''); setFollowUpNotice(''); followUpContext.current = null;
    } catch { if (sequence === requestSequence.current) { setError('The interview session could not advance to the next question. Try again, or close this window and launch it again from the Interview Helper.'); retryInput.current = (followUpOpen ? followUpInput : questionInput).current; setFocusRequest(value => value + 1); } }
    finally { if (sequence === requestSequence.current) { busy.current = false; setPending(false); } }
  };
  useEffect(() => {
    const keydown = event => {
      if (event.isComposing || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && hasResponse) {
        event.preventDefault();
        if (followUpOpen && event.target === followUpInput.current && followUp.trim()) void submitQuestion(followUp, true);
        else void nextQuestion();
        return;
      }
      // Editable fields retain caret movement; unsupported views retain scrolling.
      if (answerCard || plan?.status !== 'supported' || !plan.steps?.length || event.target?.matches?.('textarea,input,select,[contenteditable="true"]') || event.target?.closest?.('.interview-briefing')) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); setStep(value => Math.min(value + 1, plan.steps.length - 1)); }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); setStep(value => Math.max(value - 1, 0)); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  const copyCues = async () => {
    const rawAnswer = brief?.answerCard || null;
    if (rawAnswer && !hasPreparedAnswer(rawAnswer)) {
      try { await navigator.clipboard.writeText(`${rawAnswer.question}\n\nNo prepared answer yet`); setCopyStatus('Copied question. No prepared answer yet.'); }
      catch { setCopyStatus('Copy unavailable. Select the question and press ⌘/Ctrl+C.'); }
      return;
    }
    const answerCard = rawAnswer ? normalizeAnswerCard(rawAnswer) : null;
    const sourceNumbers = new Map((answerCard?.evidence || []).map((item, index) => [item.id, index + 1]));
    const cited = (statement, ids) => `${statement}${(ids || []).filter(id => sourceNumbers.has(id)).map(id => ` [${sourceNumbers.get(id)}]`).join('')}`;
    const extensions = Array.isArray(answerCard?.optionalExtension) ? answerCard.optionalExtension : [];
    const text = answerCard ? [answerCard.question, 'Your prepared answer', cited(answerCard.headline, answerCard.headlineEvidenceIds), ...answerCard.bullets.map(item => cited(item.text, item.evidenceIds)),
      cited(`Concrete example: ${answerCard.example.text}`, answerCard.example.evidenceIds),
      ...(extensions.length ? ['Optional extension', EXTENSION_CAUTION,
        ...extensions.flatMap(point => [cited(point.text, point.evidenceIds), ...(point.exampleHook ? [`Example hook: ${point.exampleHook}`] : [])])] : []),
      'Exact cited evidence', ...answerCard.evidence.map((item, index) => `[${index + 1}] ${item.sourceLabel}: ${item.quote}`), ...(answerCard.consistency?.resumeQuote ? [`Submitted résumé: ${answerCard.consistency.resumeQuote}`] : [])].join('\n\n')
      : [plan.question, ...plan.steps.map(item => `${item.cue}${item.roleAttribution ? ` (${item.roleAttribution})` : ''}`), ...(plan.missingComponents?.length ? [`Saved evidence does not document: ${plan.missingComponents.map(item => componentLabels[item] || item).join(', ')}. Do not fill that gap from this rail.`] : [])].join('\n\n');
    try { await navigator.clipboard.writeText(text); setCopyStatus(answerCard ? 'Copied prepared answer and cited evidence.' : 'Copied saved cues.'); }
    catch { setCopyStatus(`Copy unavailable. Select the ${answerCard ? 'prepared answer' : 'saved cues'} and press ⌘/Ctrl+C.`); }
  };
  const toggleAlwaysOnTop = async event => {
    const value = event.target.checked;
    setAlwaysOnTop(value);
    // Main answers true only when it applied the change; otherwise show the state the window is really in.
    try { if ((await window.interviewAPI.setAlwaysOnTop(value)) !== true) setAlwaysOnTop(!value); } catch { setAlwaysOnTop(!value); }
  };
  const active = plan?.steps?.[step] || null;
  const currentQuestion = brief?.question || plan?.question || question || answerCard?.question || '';
  const layoutMode = brief?.matching?.effectiveMode === 'continuation' ? 'continuation' : 'recall';
  const setLatencyMode = async event => {
    const mode = event.target.value;
    try {
      const updated = await window.interviewAPI.setLatencyMode(mode);
      if (updated) receiveDisplay(updated);
    } catch { setError('The answer layout could not be changed. Try again.'); setErrorTarget(null); }
  };

  return <main className={`interview-window${supported || mainCard ? ' has-answer' : ''}`} data-answer-layout={layoutMode}>
    <header><div><p className="eyebrow">{brief?.briefing?.role?.company || 'Interview companion'}{brief?.briefing?.role?.title ? ` · ${brief.briefing.role.title}` : ''}</p><h1>{mainCard || (hasPreparedAnswers && !hasResponse) ? 'Prepared interview answers' : 'Saved career evidence'}</h1>{brief && <p className={`interview-ready${brief.matching?.approximate ? ' approximate-match' : ''}`} role="status">{brief.matching?.method === 'manual' ? 'Prepared answer selected' : brief.matching?.approximate ? 'Approximate · fallback matching' : 'AI selects your prepared answer'}</p>}</div><button type="button" onClick={() => window.interviewAPI?.close?.()}>Close</button></header>
    <div className="preview-announcement" aria-live="polite" aria-atomic="true">{previewAnnouncement}</div>
    {!brief && !loadingFailed && <p>Loading prepared brief…</p>}
    {!brief && loadingFailed && <section className="interview-load-error" role="alert"><p>{error || LOAD_FAILED_MESSAGE}</p><button type="button" onClick={retryLoad}>Retry</button><button type="button" onClick={() => window.interviewAPI?.close?.()}>Close</button></section>}
    {brief && hasResponse && error && errorTarget !== 'replacement' && !(errorTarget === 'followUp' && followUpOpen) && <p className="interview-warning" role="alert">{error}</p>}
    {brief && followUpNotice && <p className="interview-warning" role="status">{followUpNotice}</p>}
    {brief && hasPreparedAnswers && plan && !mainCard && plan.status !== 'unsupported' && <p className="interview-plan-note glance-chip" role="status" title="No confident prepared answer match. Showing exact saved career cues only.">No prepared answer · saved cues</p>}
    {brief && !mainCard && plan?.status === 'unsupported' && <section className="interview-warning interview-no-answer" role="status"><p className="glance-chip glance-chip-warn">No prepared answer · answer freely</p><p className="glance-question">{plan.question}</p><details className="glance-why"><summary>Why?</summary><p>{plan.message}</p><p>Try the specific project, skill, or result mentioned in your saved career evidence.</p></details><div className="question-actions"><button ref={unsupportedEdit} type="button" disabled={pending} onClick={() => nextQuestion(true)}>Edit question</button><button type="button" disabled={pending} onClick={() => nextQuestion()}>Enter another question</button></div></section>}
    {brief && (supported || mainCard) && <>
      <section className="locked-question"><details><summary><span className="eyebrow">{supported ? 'Locked question' : 'Question in progress'}</span><span className="locked-question-preview">{supported ? currentQuestion : preview?.transcript}</span></summary><p className="current-question-text">{supported ? currentQuestion : preview?.transcript}</p></details><button type="button" disabled={pending || !supported} onClick={() => nextQuestion(true)}>Edit question</button></section>
      <ComingUp preview={comingUp}>{comingUp && <PreparedAnswer card={comingUp.card} />}</ComingUp>
      {mainCard && <PreparedAnswer key={answerRevision} card={mainCard} headingRef={answerHeading} mode={layoutMode} provisionalConfidence={!answerCard ? preview?.confidence : undefined} />}
      {!mainCard && plan.message && <p className="interview-plan-note" role="status">{plan.message}</p>}
      {!mainCard && plan.missingComponents?.length > 0 && <p className="interview-warning" role="status">Saved evidence does not document: {plan.missingComponents.map(item => componentLabels[item] || item).join(', ')}. Do not fill that gap from this rail.</p>}
      {!mainCard && active && <section className="evidence-card" aria-label="Current saved cue"><h2 ref={answerHeading} tabIndex={-1}>{active.label}</h2><p>{active.cue}</p>{active.roleAttribution && <small>{active.roleAttribution}</small>}</section>}
      {supported && <nav aria-label={answerCard ? 'Answer controls' : 'Evidence controls'}>{!answerCard && <><button type="button" onClick={() => setStep(value => Math.max(0, value - 1))} disabled={step === 0}>Previous</button><button type="button" onClick={() => setStep(value => Math.min(plan.steps.length - 1, value + 1))} disabled={step === plan.steps.length - 1}>Next</button></>}{(answerCard || plan?.steps?.length > 0) && <button type="button" disabled={pending} onClick={() => { followUpContext.current = followUpContextKey(displayedBrief.current); setFollowUpOpen(true); setFollowUpNotice(''); setError(''); }}>Follow-up</button>}<button type="button" disabled={pending} onClick={() => nextQuestion()}>Next question</button><button type="button" onClick={copyCues}>{answerCard ? 'Copy answer' : 'Copy cues'}</button></nav>}
      {supported && <p className="keyboard-help">{!answerCard && '↑/↓: move cue · '}⌘/Ctrl+Enter: {followUpOpen ? 'submit a focused, filled follow-up; otherwise next question' : 'next question'}</p>}
      {copyStatus && <p role="status" className="keyboard-help">{copyStatus}</p>}
      {followUpOpen && <form className="follow-up-form" aria-busy={pending} onSubmit={event => { event.preventDefault(); void submitQuestion(followUp, true); }}><label htmlFor="interview-follow-up">Follow-up on this example</label><textarea id="interview-follow-up" ref={followUpInput} value={followUp} disabled={pending} onChange={event => setFollowUp(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing && !event.repeat) { event.preventDefault(); void submitQuestion(followUp, true); } }} placeholder="What did you learn?" maxLength="2000" aria-describedby="interview-follow-up-help" /><p id="interview-follow-up-help" className="keyboard-help">Uses this saved example. For a different topic, choose Next question. Enter: find evidence · ⌘/Ctrl+Enter: find evidence when filled, next question when empty · Shift+Enter: new line</p>{error && errorTarget === 'followUp' && <p role="alert">{error}</p>}<button type="submit" disabled={pending}>{pending ? 'Finding saved evidence…' : 'Find follow-up evidence'}</button><button type="button" disabled={pending} onClick={() => { followUpContext.current = null; setFollowUpOpen(false); setError(''); answerHeading.current?.focus(); }}>Cancel follow-up</button></form>}
      {plan?.steps?.length > 0 && <details className="all-cues"><summary>All saved cues ({plan.steps.length})</summary><ol className="evidence-rail" aria-label="Saved evidence rail">{plan.steps.slice(0, 6).map((item, index) => <li key={item.id} aria-current={index === step ? 'step' : undefined} data-rail-state={index < step ? 'completed' : index === step ? 'current' : 'upcoming'}><button type="button" onClick={() => setStep(index)}><span>{index + 1}</span><strong>{item.label}</strong><em>{item.cue}</em><small>{item.roleAttribution}</small></button></li>)}</ol></details>}
    </>}
    {brief && <div className="answer-layout-control"><label htmlFor="interview-answer-layout">Answer layout</label><select id="interview-answer-layout" value={brief.matching?.mode || 'auto'} onChange={setLatencyMode} disabled={typeof window.interviewAPI?.setLatencyMode !== 'function'}><option value="auto">Automatic</option><option value="recall">Recall</option></select>{brief.matching?.mode === 'auto' && layoutMode === 'continuation' && <span className="keyboard-help">Matching is taking longer · keep-going cues</span>}</div>}
    {brief && <CallAudioPanel onDisplay={receiveDisplay} />}
    {brief && !hasResponse && <>
      <form onSubmit={submit} aria-busy={pending}><label htmlFor="interview-question">Current question</label><textarea id="interview-question" ref={questionInput} value={question} disabled={pending} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing && !event.repeat) { event.preventDefault(); void submitQuestion(question); } }} placeholder="Type or paste the interviewer’s question" maxLength="2000" aria-describedby="interview-question-help" /><p id="interview-question-help" className="keyboard-help">Enter: {hasPreparedAnswers ? 'find answer' : 'find evidence'} · Shift+Enter: new line</p><button type="submit" disabled={pending}>{pending ? hasPreparedAnswers ? 'Finding prepared answer…' : 'Finding saved evidence…' : hasPreparedAnswers ? 'Find prepared answer' : 'Find saved evidence'}</button>{error && <p role="alert">{error}</p>}</form>
      {preparedCards.length > 0 ? <section className="prepared-questions" aria-label="Prepared questions"><h3>Prepared questions</h3>{scopedQuestions ? <PreparedQuestionGroups cards={preparedCards} company={brief.briefing?.role?.company} onSelect={selectPreparedCard} /> : preparedCards.map(card => <button key={card.id} type="button" onClick={() => selectPreparedCard(card)}>{card.question}</button>)}</section>
        : likelyQuestions.length > 0 && <section className="prepared-questions" aria-label="Likely questions"><h3>Likely questions</h3>{likelyQuestions.map((item, index) => <button key={index} type="button" disabled={pending} onClick={() => submitQuestion(item)}>{item}</button>)}</section>}
    </>}
    {brief && hasResponse && preparedCards.length > 0 && <section className="other-prepared-answers" aria-label="Other prepared answers"><h3>Other prepared answers</h3><div className={`prepared-answer-picker${scopedQuestions ? ' grouped' : ''}`}>{scopedQuestions ? <PreparedQuestionGroups cards={preparedCards} company={brief.briefing?.role?.company} selectedId={answerCard?.id} onSelect={selectPreparedCard} /> : preparedCards.map(card => <button key={card.id} type="button" aria-pressed={answerCard?.id === card.id} onClick={() => selectPreparedCard(card)}>{card.question}</button>)}</div></section>}
    {brief && hasResponse && <form className="typed-question-fallback" aria-label="Type a different question" aria-busy={pending} onSubmit={event => { event.preventDefault(); if (typedDraft.trim()) void submitQuestion(typedDraft, false, true); }}><label htmlFor="interview-manual-question">Type a different question</label><textarea id="interview-manual-question" ref={typedDraftInput} value={typedDraft} disabled={pending} onChange={event => setTypedDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing && !event.repeat) { event.preventDefault(); if (typedDraft.trim()) void submitQuestion(typedDraft, false, true); } }} placeholder="Typing is always available" maxLength="2000" aria-describedby="interview-manual-question-help" /><p id="interview-manual-question-help" className="keyboard-help">Enter: replace the current question · Shift+Enter: new line</p>{error && errorTarget === 'replacement' && <p role="alert">{error}</p>}<button type="submit" disabled={pending || !typedDraft.trim()}>{pending ? 'Checking question…' : 'Use typed question'}</button></form>}
    <Briefing briefing={brief?.briefing} />
    <label className="pin"><input type="checkbox" checked={alwaysOnTop} onChange={toggleAlwaysOnTop} /> Keep this window on top</label>
  </main>;
}

export default InterviewWindowApp;
