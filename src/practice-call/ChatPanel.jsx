import React, { useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';

export const CHAT_MAX_LENGTH = 2000;
// The counter only appears when the end of the limit is near.
export const CHAT_COUNTER_FROM = 1800;

// The engine lets the typing flag lapse 6 s after the last report, so a long pause mid-message re-reports sooner.
export const TYPING_REFRESH_MS = 3000;

// The draft lives in the parent so closing the panel does not throw away an unsent answer.
export default function ChatPanel({ chat, draft = '', onDraftChange, disabled = false, paused = false, onSend, onTyping, onClose }) {
  const setDraft = value => { if (typeof onDraftChange === 'function') onDraftChange(value); };
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const listRef = useRef(null);
  const draftRef = useRef(null);
  // The box grows with a long answer (up to its max height) so the candidate can read what they typed.
  useEffect(() => {
    const box = draftRef.current;
    if (!box?.style) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [draft]);
  const typingRef = useRef(onTyping);
  useEffect(() => { typingRef.current = onTyping; });
  const notifyTyping = value => { if (typeof typingRef.current === 'function') typingRef.current(!!value); };
  const notifyTypingRef = useRef(notifyTyping);
  useEffect(() => { notifyTypingRef.current = notifyTyping; });
  // Closing the panel unmounts a focused box without a blur, so the end of typing is reported here.
  useEffect(() => () => { if (typeof typingRef.current === 'function') typingRef.current(false); }, []);
  const hasDraft = draft.length > 0;
  useEffect(() => {
    // A box that is disabled while focused gets no blur, so the disabled state ends the refresh itself.
    if (!focused || !hasDraft || disabled) return undefined;
    const timer = setInterval(() => notifyTypingRef.current(true), TYPING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [focused, hasDraft, disabled]);
  // Once the interviewer has left nobody is waiting on the message, so typing is reported as over.
  useEffect(() => { if (disabled) notifyTypingRef.current(false); }, [disabled]);
  const messages = Array.isArray(chat) ? chat : [];
  // The newest message stays in view, as in any chat.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);
  const submit = () => {
    const text = draft.trim();
    // While paused the draft stays in the box: only the shortcut resumes, then the candidate sends it.
    if (!text || disabled || paused) return;
    // The window hears about a pause a moment after the shortcut is pressed. A message sent in
    // that moment is refused by the call, so it is put back in the box instead of being lost.
    if (typeof onSend === 'function') {
      Promise.resolve(onSend(text)).then(result => { if (result?.paused) setDraft(current => current || text); }, () => {});
    }
    setDraft('');
    notifyTyping(false);
  };
  return <section className="flex h-full min-h-0 flex-col rounded-2xl bg-white text-[#202124]" aria-label="Call chat">
    <header className="flex items-center justify-between px-5 pb-2 pt-4">
      <h2 className="text-lg font-normal">In-call messages</h2>
      {typeof onClose === 'function' && <button type="button" aria-label="Close chat" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-[#5f6368] hover:bg-black/5"><X size={18} aria-hidden="true" /></button>}
    </header>
    <p className="mx-4 rounded-lg bg-[#f1f3f4] px-3 py-2 text-center text-xs text-[#5f6368]">{disabled ? 'The interviewer left the call, so messages are no longer read.' : 'Type instead of speaking. The interviewer reads it on the call.'}</p>
    <ol ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-3" aria-live="polite">
      {messages.map((message, index) => <li key={`${message.atMs ?? index}-${index}`} className="pc-fade">
        <span className="block text-[13px] font-medium">{message.from === 'candidate' ? 'You' : 'Interviewer'}</span>
        <span className="block whitespace-pre-wrap break-words text-[13px] leading-snug text-[#3c4043]">{message.text}</span>
      </li>)}
    </ol>
    <form className="m-4 mt-0 flex items-end gap-1 rounded-3xl bg-[#f1f3f4] py-1 pl-4 pr-1" aria-label="Send a chat message" onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea
        ref={draftRef}
        aria-label="Chat message"
        rows={1}
        maxLength={CHAT_MAX_LENGTH}
        disabled={disabled}
        className="max-h-28 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-2 text-[13px] text-[#202124] outline-none placeholder:text-[#5f6368] disabled:cursor-not-allowed"
        value={draft}
        onChange={event => { setDraft(event.target.value); notifyTyping(event.target.value.length > 0); }}
        onFocus={() => { setFocused(true); if (draft) notifyTyping(true); }}
        onBlur={() => { setFocused(false); notifyTyping(false); }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || composing || event.nativeEvent?.isComposing) return;
          event.preventDefault();
          submit();
        }}
        placeholder={disabled ? 'The interviewer has left' : 'Send a message'}
      />
      {draft.length >= CHAT_COUNTER_FROM && <span data-testid="chat-counter" className="self-center text-[11px] tabular-nums text-[#5f6368]">{draft.length}/{CHAT_MAX_LENGTH}</span>}
      <button type="submit" aria-label="Send chat message" className="grid h-9 w-9 place-items-center rounded-full text-[#1a73e8] hover:bg-black/5 disabled:text-[#9aa0a6] disabled:hover:bg-transparent" disabled={disabled || paused || !draft.trim()}><Send size={18} aria-hidden="true" /></button>
    </form>
    {paused && !disabled && <p role="status" data-chat-paused="true" className="mx-5 mb-3 -mt-2 text-xs text-[#5f6368]">Paused. Press ⌘P to resume and send.</p>}
  </section>;
}
