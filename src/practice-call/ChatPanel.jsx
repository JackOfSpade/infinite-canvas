import React, { useState } from 'react';
import { Send } from 'lucide-react';

export default function ChatPanel({ chat, typing, onSend, onTyping }) {
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
  return <section className="flex h-full min-h-0 flex-col rounded-lg border border-white/10 bg-black/25" aria-label="Call chat">
    <p className="border-b border-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/45">Chat</p>
    <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2" aria-live="polite">
      {messages.length === 0 && <li className="text-[11px] text-white/40">Type instead of speaking. The interviewer reads it on the call.</li>}
      {messages.map((message, index) => <li key={`${message.atMs ?? index}-${index}`} className={message.from === 'candidate' ? 'text-right' : ''}>
        <span className="block text-[9px] uppercase text-white/40">{message.from === 'candidate' ? 'You' : 'Interviewer'}</span>
        <span className={`inline-block rounded-md px-1.5 py-1 text-[11px] ${message.from === 'candidate' ? 'bg-violet-500/25 text-violet-50' : 'bg-white/10 text-white/85'}`}>{message.text}</span>
      </li>)}
      {typing && <li data-testid="chat-typing" aria-label="Interviewer is typing" className="text-[10px] text-violet-200">Interviewer is typing…</li>}
    </ol>
    <form className="flex items-center gap-1 border-t border-white/10 p-1.5" aria-label="Send a chat message" onSubmit={event => { event.preventDefault(); submit(); }}>
      <input
        aria-label="Chat message"
        className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[11px] text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
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
        placeholder="Type a message"
      />
      <button type="submit" aria-label="Send chat message" className="rounded border border-white/10 p-1 text-violet-200 hover:bg-white/5 disabled:opacity-40" disabled={!draft.trim()}><Send size={12} aria-hidden="true" /></button>
    </form>
  </section>;
}
