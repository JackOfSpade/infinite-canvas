import React, { useId, useRef, useState } from 'react';

/** Tokens, not filesystem paths, cross this searchable Applied Jobs chooser. */
export function InterviewApplicationPicker({ nodeId, canvasFilePath = null, disabled, selectedLabel, onSelect }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState({ folders: [] });
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(-1);
  const openRef = useRef(false);
  const sequence = useRef(0);
  const selectionBusy = useRef(false);
  const options = result.folders.filter(folder => [folder.company, folder.role, folder.location, folder.label]
    .some(value => String(value || '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));

  const close = () => { openRef.current = false; sequence.current += 1; setOpen(false); setActive(-1); setLoading(false); };
  const show = async () => {
    if (disabled || openRef.current || selectionBusy.current) return;
    openRef.current = true; setOpen(true); setLoading(true); setError(''); setActive(-1);
    const request = ++sequence.current;
    try {
      if (!window.electronAPI?.listInterviewApplicationFolders) throw new Error('Application folders are unavailable.');
      const reply = await window.electronAPI.listInterviewApplicationFolders({ nodeId, canvasFilePath });
      if (request === sequence.current) setResult({ ...reply, folders: Array.isArray(reply?.folders) ? reply.folders : [] });
    } catch (failure) {
      if (request === sequence.current) { setResult({ folders: [] }); setError(failure?.message || 'Could not list applications. Open the dropdown to retry.'); }
    } finally { if (request === sequence.current) setLoading(false); }
  };
  const select = async folder => {
    if (!folder || disabled || selectionBusy.current) return;
    selectionBusy.current = true; setSelecting(true); setError('');
    try {
      const accepted = await onSelect(folder.token);
      if (accepted !== false) { setQuery(''); close(); }
    } catch (failure) { setError(failure?.message || 'Could not select this application. Try again.'); }
    finally { selectionBusy.current = false; setSelecting(false); }
  };
  const keyDown = event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); close(); } return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { void show(); return; }
      const next = options.length ? (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : -1;
      setActive(next);
      document.getElementById(`${id}-option-${next}`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter' && open) { event.preventDefault(); if (!loading) void select(options[active]); }
  };

  return <div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <label htmlFor={id} className="mb-1 block text-[10px] font-semibold text-[var(--text-muted)]">Application under Applied Jobs</label>
    <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`}
      aria-activedescendant={open && !loading && options[active] ? `${id}-option-${active}` : undefined}
      aria-describedby={`${id}-help`} autoComplete="off" value={query} disabled={disabled || selecting}
      placeholder={selectedLabel || 'Search company, role or location…'}
      onFocus={() => { void show(); }} onClick={() => { void show(); }} onKeyDown={keyDown}
      onChange={event => { setQuery(event.target.value); setActive(-1); void show(); }}
      className="nodrag nowheel w-full rounded-md border border-[var(--border-main)] bg-[var(--bg-input)] px-2 py-2 text-xs text-[var(--text-main)] focus-visible:outline-2 focus-visible:outline-blue-400" />
    <p id={`${id}-help`} className="mt-1 text-[10px] text-[var(--text-muted)]">{selecting ? 'Selecting application…' : selectedLabel ? `Selected: ${selectedLabel}` : 'Choose the application you submitted.'}</p>
    {open && <div className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border border-[var(--border-main)] bg-[var(--bg-node)] p-1 shadow-xl nodrag nowheel">
      <ul id={`${id}-list`} role="listbox" aria-label="Application folders" aria-busy={loading || selecting}>
        {!loading && options.map((folder, index) => <li key={folder.token} id={`${id}-option-${index}`} role="option" aria-selected={active === index}
          className={`cursor-pointer rounded p-2 text-xs text-[var(--text-main)] ${active === index ? 'bg-blue-500/20' : 'hover:bg-blue-500/10'}`}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => { void select(folder); }}>
          <span className="block font-medium">{folder.label || [folder.company, folder.role].filter(Boolean).join(' · ')}</span>
          <span className="block text-[10px] text-[var(--text-muted)]">{[folder.company, folder.role, folder.location].filter(Boolean).join(' · ')}</span>
        </li>)}
      </ul>
      {loading ? <p role="status" className="p-2 text-xs text-[var(--text-muted)]">Loading applications…</p>
        : !error && !options.length && <p role="status" className="p-2 text-xs text-[var(--text-muted)]">{result.reason === 'canvas-unsaved' ? 'Save your canvas to list applications' : query.trim() && result.folders.length ? 'No matching applications.' : 'No application folders found under Applied Jobs.'}</p>}
    </div>}
    {error && <p role="alert" className="mt-1 text-xs text-amber-500">{error}</p>}
  </div>;
}
