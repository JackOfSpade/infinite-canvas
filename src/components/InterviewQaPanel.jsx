import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { updateModalCount } from './modalStack';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { InterviewQaBadges } from './InterviewQaBadges';

const buttonClass = 'rounded-md border border-[var(--border-main)] px-2 py-1 text-xs hover:bg-blue-500/10 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-blue-400';
const inputClass = 'mt-1 w-full rounded-md border border-[var(--border-main)] bg-[var(--bg-input)] px-2 py-1.5 text-xs text-[var(--text-main)]';
const emptyQa = () => ({ foundation: { status: 'missing', cards: [] }, company: { status: 'missing', company: '', cards: [], foundationLinks: [] } });
const sameQuestion = (left, right) => String(left || '').trim().toLocaleLowerCase() === String(right || '').trim().toLocaleLowerCase();

function CardForm({ card, scope, onSave, onCancel, busy }) {
  const [draft, setDraft] = useState(() => ({ ...card, variants: [...(card.variants || [])], bullets: (card.bullets || []).map(item => ({ ...item })), extensions: (card.extensions || []).map(item => ({ ...item })) }));
  const [error, setError] = useState('');
  const nextExtension = useRef(0);
  const field = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const save = async event => {
    event.preventDefault();
    if (!draft.question.trim()) { setError('Write a question before saving.'); return; }
    setError('');
    try { await onSave({ ...draft, scope, author: 'user' }); }
    catch (failure) { setError(failure?.message || 'Could not save this answer. Your text is still here; try again.'); }
  };
  return <form onSubmit={save} className="space-y-3 rounded-lg border border-blue-400/40 p-3" aria-label={card.id ? `Edit ${card.question}` : `Add ${scope} card`} aria-busy={busy}>
    {scope === 'foundation' && <p className="text-xs text-amber-500">Foundation edits apply to every interview.</p>}
    <fieldset disabled={busy} className="space-y-3">
      <label className="block text-xs">Question<input autoFocus className={inputClass} value={draft.question} onChange={event => field('question', event.target.value)} /></label>
      <label className="block text-xs">Variants (one per line)<textarea className={inputClass} rows={2} value={draft.variants.join('\n')} onChange={event => field('variants', event.target.value.split('\n'))} /></label>
      <label className="block text-xs">Headline<textarea className={inputClass} rows={2} value={draft.headline || ''} onChange={event => field('headline', event.target.value)} /></label>
      <fieldset className="space-y-2"><legend className="text-xs font-medium">Recall bullets</legend>
        {draft.bullets.map((bullet, index) => <div key={index} className="flex items-start gap-2">
          <label className="min-w-0 flex-1 text-xs">Bullet {index + 1}<textarea className={inputClass} rows={2} value={bullet.text} onChange={event => field('bullets', draft.bullets.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /></label>
          <button type="button" className={buttonClass} aria-label={`Remove bullet ${index + 1}`} onClick={() => field('bullets', draft.bullets.filter((_, i) => i !== index))}>Remove</button>
        </div>)}
        <button type="button" className={buttonClass} onClick={() => field('bullets', [...draft.bullets, { text: '' }])}>Add bullet</button>
      </fieldset>
      <label className="block text-xs">Example<textarea className={inputClass} rows={3} value={draft.example || ''} onChange={event => field('example', event.target.value)} /></label>
      <fieldset className="space-y-2"><legend className="text-xs font-medium">Extension points (optional)</legend>
        {draft.extensions.map((extension, index) => <div key={extension.id || index} className="flex items-start gap-2">
          <label className="min-w-0 flex-1 text-xs">Extension {index + 1}<textarea className={inputClass} rows={2} value={extension.text} onChange={event => field('extensions', draft.extensions.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /></label>
          <button type="button" className={buttonClass} aria-label={`Remove extension ${index + 1}`} onClick={() => field('extensions', draft.extensions.filter((_, i) => i !== index))}>Remove</button>
        </div>)}
        <button type="button" className={buttonClass} onClick={() => field('extensions', [...draft.extensions, { id: `user-${Date.now()}-${++nextExtension.current}`, text: '' }])}>Add extension</button>
      </fieldset>
      {error && <p role="alert" className="text-xs text-amber-500">{error}</p>}
      <div className="flex gap-2"><button type="submit" className={buttonClass}>Save</button><button type="button" className={buttonClass} onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>;
}

function QaCard({ card, scope, company, links, mutate, busy, readOnly }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setError('');
    try { await mutate('delete', scope, card); setConfirmDelete(false); }
    catch (failure) { setError(failure?.message || 'Could not delete this card. Try again.'); }
  };
  return <article className="space-y-2 rounded-lg border border-[var(--border-main)] p-3" aria-label={card.question}>
    {editing ? <CardForm card={card} scope={scope} busy={busy || readOnly} onCancel={() => setEditing(false)} onSave={async draft => { await mutate('save', scope, draft); setEditing(false); }} /> : <>
      <h4 className="text-sm font-semibold">{card.question}</h4>
      <InterviewQaBadges card={card} details />
      {card.variants?.length > 0 && <details className="text-xs text-[var(--text-muted)]"><summary className="cursor-pointer">Question variants ({card.variants.length})</summary><ul className="list-disc pl-4">{card.variants.map((variant, index) => <li key={index}>{variant}</li>)}</ul></details>}
      {(card.status === 'needs-prep' || card.status === 'empty') && <p className="text-xs text-amber-500">No prepared answer yet. Write your own answer, or Prepare to fill empty answers.</p>}
      {card.headline && <p className="whitespace-pre-wrap text-sm font-medium">{card.headline}</p>}
      {card.bullets?.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs">{card.bullets.map((bullet, index) => <li key={index}>{bullet.stage && <span className="text-[var(--text-muted)]">{bullet.stage}: </span>}{bullet.text}</li>)}</ul>}
      {card.example && <div className="text-xs"><p className="font-medium">Example</p><p className="whitespace-pre-wrap">{card.example}</p></div>}
      {card.extensions?.length > 0 && <details className="text-xs"><summary className="cursor-pointer">Extension points (optional)</summary><ul className="list-disc pl-4">{card.extensions.map((item, index) => <li key={item.id || index}>{item.text}</li>)}</ul></details>}
      {card.thinEvidence && <p className="text-xs text-amber-500">Thin evidence — use only details you can support.</p>}
      <div className="flex gap-2"><button type="button" className={buttonClass} disabled={busy || readOnly} onClick={() => { setEditing(true); setError(''); }}>Edit</button><button type="button" className={buttonClass} disabled={busy || readOnly} onClick={() => setConfirmDelete(true)}>Delete</button></div>
    </>}
    {links?.length > 0 && <ul className="space-y-1 border-t border-[var(--border-main)] pt-2 text-xs text-[var(--text-muted)]">{links.map((link, index) => <li key={index}>Also asked at {company || 'this company'}: “{link.question}”{(/^https?:\/\//i.test(link.sourceUrl || '')) && <> — <a className="underline" href={link.sourceUrl} target="_blank" rel="noreferrer">source</a></>}</li>)}</ul>}
    {confirmDelete && <div role="group" aria-label="Confirm card deletion" className="space-y-2 rounded-md border border-amber-500/40 p-2 text-xs">
      <p>Delete “{card.question}”?{scope === 'foundation' ? ' This applies to every interview.' : ''}</p>
      <div className="flex gap-2"><button type="button" className={buttonClass} disabled={busy || readOnly} onClick={() => { void remove(); }}>Confirm delete</button><button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmDelete(false)}>Keep card</button></div>
    </div>}
    {error && <p role="alert" className="text-xs text-amber-500">{error}</p>}
  </article>;
}

function QaSection({ scope, section, company, foundationLinks, mutate, busy, readOnly }) {
  const [adding, setAdding] = useState(false);
  const title = scope === 'foundation' ? 'Foundation Q&A · shared across all interviews' : `${company || 'Company'} Q&A`;
  return <section className="space-y-3" aria-label={title}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{title}</h3><button type="button" className={buttonClass} disabled={busy || readOnly || adding} onClick={() => setAdding(true)}>Add card</button></div>
    {scope === 'foundation' && <p className="text-xs text-[var(--text-muted)]">Editing this shared set applies to every interview.</p>}
    {!section.cards.length && <p className="text-xs text-[var(--text-muted)]">No cards yet. Add your own question or Prepare to get started.</p>}
    {section.cards.map(card => <QaCard key={card.id} card={card} scope={scope} company={company} links={scope === 'foundation' ? foundationLinks.filter(link => sameQuestion(link.foundationQuestion, card.question)) : []} mutate={mutate} busy={busy} readOnly={readOnly} />)}
    {adding && <CardForm scope={scope} card={{ scope, question: '', variants: [], headline: '', bullets: [], example: '', extensions: [], origin: 'user', source: null, author: 'user', status: 'empty', thinEvidence: false }} busy={busy || readOnly}
      onCancel={() => setAdding(false)} onSave={async draft => { await mutate('add', scope, draft); setAdding(false); }} />}
  </section>;
}

function QaDialog({ qa, error, loading, reload, mutate, busy, readOnly, onClose }) {
  const ref = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    updateModalCount(1);
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { updateModalCount(-1); if (previous instanceof HTMLElement && document.contains(previous)) previous.focus(); };
  }, []);
  useEscapeToClose(event => { event.preventDefault(); if (!busy) onClose(); }, { capture: true });
  const trap = event => {
    if (event.key !== 'Tab') return;
    const elements = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], summary')];
    const first = elements[0]; const last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return createPortal(<div className="nodrag nowheel fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trap} className="flex max-h-[90vh] w-[720px] max-w-full flex-col rounded-xl border border-[var(--border-main)] bg-[var(--bg-node)] text-[var(--text-main)] shadow-2xl">
      <header className="flex items-center justify-between border-b border-[var(--border-main)] p-4"><h2 id={titleId} className="text-base font-semibold">Edit Q&A</h2><button ref={closeRef} type="button" className={buttonClass} disabled={busy} onClick={onClose}>Close</button></header>
      <div className="space-y-6 overflow-y-auto p-4">
        {readOnly && <p className="text-xs text-[var(--text-muted)]">Q&A editing is disabled while this helper is locked or preparing.</p>}
        {loading && <p role="status" className="text-xs">Loading Q&A…</p>}
        {error && <p role="alert" className="text-xs text-amber-500">{error} <button type="button" className={buttonClass} disabled={loading || busy} onClick={reload}>Retry loading Q&A</button></p>}
        <QaSection scope="foundation" section={qa.foundation} company={qa.company.company} foundationLinks={qa.company.foundationLinks || []} mutate={mutate} busy={busy} readOnly={readOnly} />
        <QaSection scope="company" section={qa.company} company={qa.company.company} foundationLinks={[]} mutate={mutate} busy={busy} readOnly={readOnly} />
      </div>
    </div>
  </div>, document.body);
}

export function InterviewQaPanel({ nodeId, snapshotId, refreshKey, disabled = false }) {
  const [qa, setQa] = useState(emptyQa);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const mutating = useRef(false);
  const reload = useCallback(async () => {
    if (!window.electronAPI?.loadInterviewQa || mutating.current) return;
    const request = ++sequence.current;
    setLoading(true); setError('');
    try {
      const reply = await window.electronAPI.loadInterviewQa({ nodeId, snapshotId: snapshotId || null });
      if (reply?.success === false) throw new Error(reply.error || 'Q&A response was invalid.');
      if (!Array.isArray(reply?.foundation?.cards) || !Array.isArray(reply?.company?.cards)) throw new Error('Q&A response was invalid.');
      if (request === sequence.current) setQa(reply);
    } catch (failure) { if (request === sequence.current) setError(failure?.message || 'Could not load Q&A. Try again.'); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [nodeId, snapshotId]);
  useEffect(() => {
    // First load runs after commit so the effect body itself never sets state.
    const initial = setTimeout(() => { void reload(); }, 0);
    const changed = event => { if (event.detail?.nodeId !== nodeId) void reload(); };
    window.addEventListener('interview-qa-changed', changed);
    window.addEventListener('focus', reload);
    return () => { clearTimeout(initial); sequence.current += 1; window.removeEventListener('interview-qa-changed', changed); window.removeEventListener('focus', reload); };
  }, [nodeId, reload, refreshKey]);
  const mutate = async (operation, scope, card) => {
    if (disabled || mutating.current) throw new Error('Q&A is busy. Try again in a moment.');
    mutating.current = true; sequence.current += 1; setLoading(false); setBusy(true);
    try {
      const method = { save: 'saveInterviewQaCard', add: 'addInterviewQaCard', delete: 'deleteInterviewQaCard' }[operation];
      if (!window.electronAPI?.[method]) throw new Error('Q&A editing is unavailable in this app version.');
      const reply = await window.electronAPI[method](operation === 'delete' ? { nodeId, scope, cardId: card.id } : { nodeId, scope, card });
      if (reply?.success === false) throw new Error(`${reply.error || 'Q&A update failed.'} Your text has been kept.`);
      if (!Array.isArray(reply?.cards)) throw new Error('Q&A update response was invalid. Your text has been kept.');
      setQa(previous => ({ ...previous, [scope]: { ...previous[scope], ...reply } }));
      // Other helpers reload the one shared Foundation set; local edits use the
      // authoritative returned section instead of a second, racing read.
      window.dispatchEvent(new window.CustomEvent('interview-qa-changed', { detail: { nodeId, scope } }));
    } finally { mutating.current = false; setBusy(false); }
  };
  const cards = [...qa.foundation.cards, ...qa.company.cards];
  const disclosed = qa.company.cards.filter(card => card.origin === 'disclosed').length;
  const needsPrep = cards.filter(card => card.status === 'needs-prep' || card.status === 'empty').length;
  return <section aria-label="Interview Q&A" className="break-inside-avoid space-y-2 border-t border-white/10 pt-3">
    <p className="text-[11px] text-white/70" role="status">Foundation {qa.foundation.cards.length} · {qa.company.company || 'Company'} {qa.company.cards.length} · {disclosed} disclosed · {needsPrep} need prep</p>
    <button type="button" className="nodrag w-full rounded-md border border-white/15 px-2 py-1.5 text-xs disabled:opacity-40" onClick={() => { setOpen(true); void reload(); }}>Edit Q&A</button>
    {error && !open && <p role="alert" className="text-xs text-amber-200">{error} <button type="button" className="underline" onClick={() => { void reload(); }}>Retry loading Q&A</button></p>}
    {open && <QaDialog qa={qa} error={error} loading={loading} reload={() => { void reload(); }} mutate={mutate} busy={busy} readOnly={disabled} onClose={() => setOpen(false)} />}
  </section>;
}
