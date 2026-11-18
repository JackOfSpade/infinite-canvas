import React, { useEffect, useRef, useState } from 'react';
import { PAD_TEXT_MAX, padKeyInsert } from './screenMarkup.js';

// Matches the chat box: the engine lets the typing flag lapse after about 6 s.
export const PAD_TYPING_REFRESH_MS = 3000;
export const PAD_TYPING_IDLE_MS = 4000;
export const PAD_SEND_DEBOUNCE_MS = 400;
const NEAR_CAP = 18000;

// The candidate's editor. The window owns the text: it is seeded once from
// initialText when the pad mounts and later state updates never overwrite it.
// readOnly shows `value` instead (the replay) and sends nothing.
export default function CodingPad({ lang = '', initialText = '', value = '', readOnly = false, disabled = false, onChange, onTyping, className = '' }) {
  const [own, setOwn] = useState(() => String(initialText || '').slice(0, PAD_TEXT_MAX));
  const text = readOnly ? String(value || '') : own;
  const textRef = useRef(own);
  const dirtyRef = useRef(false);
  const sendTimerRef = useRef(null);
  const idleTimerRef = useRef(null);
  const typingRef = useRef({ on: false, at: 0 });
  const cursorRef = useRef(null);
  const areaRef = useRef(null);
  const gutterRef = useRef(null);
  const callbacks = useRef({});
  useEffect(() => { callbacks.current = { onChange, onTyping }; });

  const flush = () => {
    clearTimeout(sendTimerRef.current);
    sendTimerRef.current = null;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    if (typeof callbacks.current.onChange === 'function') callbacks.current.onChange(textRef.current);
  };
  const stopTyping = () => {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
    if (!typingRef.current.on) return;
    typingRef.current.on = false;
    if (typeof callbacks.current.onTyping === 'function') callbacks.current.onTyping(false);
  };
  const beat = () => {
    const now = Date.now();
    if (!typingRef.current.on || now - typingRef.current.at >= PAD_TYPING_REFRESH_MS) {
      typingRef.current = { on: true, at: now };
      if (typeof callbacks.current.onTyping === 'function') callbacks.current.onTyping(true);
    }
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(stopTyping, PAD_TYPING_IDLE_MS);
  };
  // Closing the pad unmounts it: the last text still goes out and typing ends.
  useEffect(() => () => { if (!readOnly) { flush(); stopTyping(); } }, [readOnly]);
  useEffect(() => { if (disabled) stopTyping(); }, [disabled]);
  useEffect(() => {
    const at = cursorRef.current;
    if (at === null || !areaRef.current) return;
    cursorRef.current = null;
    try { areaRef.current.setSelectionRange(at, at); } catch { /* element detached */ }
  }, [own]);

  const edit = next => {
    textRef.current = next;
    dirtyRef.current = true;
    setOwn(next);
    clearTimeout(sendTimerRef.current);
    sendTimerRef.current = setTimeout(flush, PAD_SEND_DEBOUNCE_MS);
    beat();
  };
  const onKeyDown = event => {
    if (readOnly) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key !== 'Tab' && event.key !== 'Enter') return;
    event.preventDefault();
    const area = event.currentTarget;
    const start = area.selectionStart ?? own.length;
    const end = area.selectionEnd ?? start;
    const insert = padKeyInsert(event.key, own.slice(0, start));
    const next = `${own.slice(0, start)}${insert}${own.slice(end)}`;
    if (next.length > PAD_TEXT_MAX) return;
    cursorRef.current = start + insert.length;
    edit(next);
  };
  const lineCount = text.split('\n').length;
  const numbers = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
  // The gutter follows the textarea scroll directly so numbers never lag a frame.
  const syncGutter = event => {
    const inner = gutterRef.current;
    if (inner) inner.style.transform = `translateY(${-event.currentTarget.scrollTop}px)`;
  };
  return <section aria-label="Coding pad" data-coding-pad={readOnly ? 'readonly' : 'live'} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-[#1e1f22] text-[#e8eaed] ${className}`}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
      <h2 className="text-sm font-medium">Coding pad{lang && <span data-pad-lang="true" className="ml-2 rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs font-normal text-[#9aa0a6]">{lang}</span>}</h2>
      {!readOnly && <div className="flex items-center gap-3">
        {text.length >= NEAR_CAP && <span data-testid="pad-counter" className="text-[11px] tabular-nums text-[#9aa0a6]">{text.length}/{PAD_TEXT_MAX}</span>}
      </div>}
    </header>
    <div className="relative flex min-h-0 flex-1">
      <div aria-hidden="true" data-pad-gutter="true" className="w-12 shrink-0 select-none overflow-hidden bg-black/20 py-3 pr-2 text-right font-mono text-[13px] leading-5 text-[#6b7075]">
        <pre ref={gutterRef} className="font-[inherit]">{numbers}</pre>
      </div>
      <textarea ref={areaRef} aria-label={readOnly ? 'Coding pad contents' : 'Code'} wrap="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        readOnly={readOnly} maxLength={PAD_TEXT_MAX} value={text}
        onChange={readOnly ? undefined : event => edit(event.target.value.slice(0, PAD_TEXT_MAX))}
        onKeyDown={onKeyDown} onScroll={syncGutter} onBlur={readOnly ? undefined : () => { flush(); stopTyping(); }}
        placeholder={readOnly ? undefined : 'Write your code here'}
        className="min-h-0 min-w-0 flex-1 resize-none overflow-auto whitespace-pre bg-transparent py-3 pl-3 pr-3 font-mono text-[13px] leading-5 text-[#e8eaed] outline-none placeholder:text-[#6b7075]" />
    </div>
  </section>;
}
