import React, { useState } from 'react';
import { Send, X } from 'lucide-react';

export default function ChatPanel({ chat, typing, onSend, onTyping, onClose }) {
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const notifyTyping = value => { if (typeof onTyping === 'function') onTyping(!!value); };
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (typeof onSend === 'function') onSend(text.slice(0, 2000));
    setDraft('');
    notifyTyping(false);
  };
  const messages = Array.isArray(chat) ? chat : [];
  return <section className="flex h-full min-h-0 flex-col rounded-2xl bg-white text-[#202124]" aria-label="Call chat">
    <header className="flex items-center justify-between px-5 pb-2 pt-4">
      <h2 className="text-lg font-normal">In-call messages</h2>
      {typeof onClose === 'function' && <button type="button" aria-label="Close chat" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-[#5f6368] hover:bg-black/5"><X size={18} aria-hidden="true" /></button>}
    </header>
    <p className="mx-4 rounded-lg bg-[#f1f3f4] px-3 py-2 text-center text-xs text-[#5f6368]">Type instead of speaking. The interviewer reads it on the call.</p>
    <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-3" aria-live="polite">
      {messages.map((message, index) => <li key={`${message.atMs ?? index}-${index}`} className="pc-fade">
        <span className="block text-[13px] font-medium">{message.from === 'candidate' ? 'You' : 'Interviewer'}</span>
        <span className="block whitespace-pre-wrap break-words text-[13px] leading-snug text-[#3c4043]">{message.text}</span>
      </li>)}
      {typing && <li data-testid="chat-typing" aria-label="Interviewer is typing" className="text-xs text-[#5f6368]">Interviewer is typing…</li>}
    </ol>
    <form className="m-4 mt-0 flex items-center gap-1 rounded-full bg-[#f1f3f4] py-1 pl-4 pr-1" aria-label="Send a chat message" onSubmit={event => { event.preventDefault(); submit(); }}>
      <input
        aria-label="Chat message"
        className="min-w-0 flex-1 bg-transparent text-[13px] text-[#202124] outline-none placeholder:text-[#5f6368]"
        value={draft}
        onChange={event => { setDraft(event.target.value); notifyTyping(true); }}
        onFocus={() => notifyTyping(true)}
        onBlur={() => notifyTyping(false)}
        onCompositionStart={() => { setComposing(true); notifyTyping(true); }}
        onCompositionEnd={() => { setComposing(false); notifyTyping(true); }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || composing || event.nativeEvent?.isComposing) return;
          event.preventDefault();
          submit();
        }}
        placeholder="Send a message"
      />
      <button type="submit" aria-label="Send chat message" className="grid h-9 w-9 place-items-center rounded-full text-[#1a73e8] hover:bg-black/5 disabled:text-[#9aa0a6] disabled:hover:bg-transparent" disabled={!draft.trim()}><Send size={18} aria-hidden="true" /></button>
    </form>
  </section>;
}
