import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Captions, ListChecks, MessageSquare, Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react';
import ChatPanel from './ChatPanel.jsx';
import { initialsOf, roleLine } from './persona.js';
import { formatTime } from './replayModel.js';

const controlClass = pressed => `flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${pressed ? 'border-violet-300/60 bg-violet-500/30 text-violet-50' : 'border-white/10 bg-black/25 text-white/70 hover:bg-white/5'}`;

export default function InCall({ state, api }) {
  const [captionsOn, setCaptionsOn] = useState(false);
  const [cardsOpen, setCardsOpen] = useState(false);
  const [cards, setCards] = useState([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const stopCamera = useCallback(() => {
    try { streamRef.current?.getTracks?.().forEach(track => track.stop?.()); } catch { /* tracks already ended */ }
    streamRef.current = null;
    if (videoRef.current) { try { videoRef.current.srcObject = null; } catch { /* element detached */ } }
  }, []);
  useEffect(() => stopCamera, [stopCamera]);
  // The <video> only exists while the camera is on, so attach the stream once
  // the element mounts rather than before the re-render.
  useEffect(() => {
    if (!cameraOn || !streamRef.current || !videoRef.current) return;
    try { videoRef.current.srcObject = streamRef.current; } catch { /* element detached */ }
  }, [cameraOn]);

  const toggleCamera = async () => {
    if (cameraOn) { stopCamera(); setCameraOn(false); return; }
    const getUserMedia = typeof navigator !== 'undefined' ? navigator.mediaDevices?.getUserMedia : null;
    if (typeof getUserMedia !== 'function') { setCameraError('Camera is unavailable in this window.'); return; }
    try {
      // Video only: the call microphone never goes through getUserMedia.
      const stream = await getUserMedia.call(navigator.mediaDevices, { video: true });
      streamRef.current = stream;
      setCameraOn(true); setCameraError(null);
    } catch { setCameraError('Camera permission was denied. The call continues without video.'); }
  };
  const toggleCards = async () => {
    if (cardsOpen) { setCardsOpen(false); return; }
    setCardsOpen(true);
    if (typeof api?.getPreparedCards !== 'function') return;
    try { const result = await api.getPreparedCards(); setCards(Array.isArray(result) ? result : []); } catch { setCards([]); }
  };
  const hangUp = () => {
    stopCamera();
    if (typeof api?.hangUp === 'function') api.hangUp();
  };
  const muted = !!state?.muted;
  const captions = Array.isArray(state?.captions) ? state.captions : [];
  return <main className="flex min-h-screen flex-col bg-[#111018] text-violet-50" aria-label="Practice call in progress">
    <header className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
      <p className="text-[11px] text-white/60">Practice call · {roleLine(state?.persona) || 'Interviewer'}</p>
      <p role="timer" aria-label="Call timer" className="font-mono text-[11px] text-white/70">{formatTime(state?.elapsedMs)}</p>
    </header>
    <div className="flex min-h-0 flex-1 gap-2 p-2">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
          <section aria-label="Interviewer" data-speaking={state?.speaking === 'interviewer' ? 'true' : 'false'} className={`relative grid place-items-center rounded-xl border bg-[#181521] p-3 transition ${state?.speaking === 'interviewer' ? 'border-violet-300/60 ring-4 ring-violet-400/30' : 'border-white/10'}`}>
            <div className={`grid h-16 w-16 place-items-center rounded-full bg-violet-500/20 text-xl font-semibold text-violet-100 ${state?.speaking === 'interviewer' ? 'animate-pulse ring-4 ring-violet-300/40' : ''}`} aria-hidden="true">{initialsOf(state?.persona)}</div>
            <p className="absolute bottom-2 left-2 text-[11px] text-white/75">{state?.persona?.name || 'Interviewer'}{state?.speaking === 'interviewer' && <span className="ml-1 text-violet-200">speaking</span>}</p>
          </section>
          <section aria-label="Your camera" data-camera={cameraOn ? 'on' : 'off'} className="relative grid min-h-24 place-items-center overflow-hidden rounded-xl border border-white/10 bg-[#181521] p-3">
            {cameraOn && <video ref={videoRef} autoPlay playsInline muted aria-label="Local camera preview" className="h-full w-full rounded-lg object-cover" />}
            {!cameraOn && <p className="text-[11px] text-white/45">Camera off</p>}
            <p className="absolute bottom-2 left-2 text-[10px] text-white/50">You{cameraOn ? ' · preview only, not sent' : ''}</p>
          </section>
        </div>
        {cameraError && <p role="alert" className="text-[11px] text-amber-100">{cameraError}</p>}
        {captionsOn && <section aria-label="Live captions" className="max-h-24 space-y-0.5 overflow-y-auto rounded-lg border border-white/10 bg-black/25 p-2 text-[11px] text-white/75">
          {captions.length === 0 && <p className="text-white/40">Captions appear as the call goes on.</p>}
          {captions.map((caption, index) => <p key={`${caption.atMs ?? index}-${index}`}><span className="text-violet-200">{caption.speaker === 'candidate' ? 'You' : 'Interviewer'}:</span> {caption.text}</p>)}
        </section>}
        {cardsOpen && <section aria-label="Prepared answer cards" className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-white/10 bg-black/25 p-2">
          {cards.length === 0 && <p className="text-[11px] text-white/40">No prepared answers for this interview.</p>}
          {cards.map(card => <article key={card.id || card.question} className="rounded border border-white/10 p-1.5"><p className="text-[11px] text-violet-100">{card.question}</p><p className="text-[11px] whitespace-pre-wrap text-white/70">{card.answer}</p></article>)}
        </section>}
      </div>
      {chatOpen && <div className="w-64 shrink-0"><ChatPanel chat={state?.chat} typing={!!state?.typing} onSend={api?.sendChat} onTyping={api?.setTyping} /></div>}
    </div>
    <footer className="flex flex-wrap items-center justify-center gap-1.5 border-t border-white/10 px-2 py-2">
      <button type="button" className={controlClass(muted)} aria-pressed={muted} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => { if (typeof api?.setMuted === 'function') api.setMuted(!muted); }}>{muted ? <MicOff size={12} aria-hidden="true" /> : <Mic size={12} aria-hidden="true" />}{muted ? 'Unmute' : 'Mute'}</button>
      <button type="button" className={controlClass(captionsOn)} aria-pressed={captionsOn} aria-label="Captions" onClick={() => setCaptionsOn(value => !value)}><Captions size={12} aria-hidden="true" />Captions</button>
      <button type="button" className={controlClass(cardsOpen)} aria-pressed={cardsOpen} aria-label="Prepared answer cards" onClick={toggleCards}><ListChecks size={12} aria-hidden="true" />Cards</button>
      <button type="button" className={controlClass(chatOpen)} aria-pressed={chatOpen} aria-label="Chat" onClick={() => setChatOpen(value => !value)}><MessageSquare size={12} aria-hidden="true" />Chat</button>
      <button type="button" className={controlClass(cameraOn)} aria-pressed={cameraOn} aria-label={cameraOn ? 'Turn off camera' : 'Turn on camera'} onClick={toggleCamera}>{cameraOn ? <VideoOff size={12} aria-hidden="true" /> : <Video size={12} aria-hidden="true" />}Camera</button>
      <button type="button" className="flex items-center gap-1 rounded-md border border-red-400/40 bg-red-500/25 px-2 py-1 text-[11px] text-red-100 hover:bg-red-500/35" aria-label="Hang up" onClick={hangUp}><PhoneOff size={12} aria-hidden="true" />Hang up</button>
    </footer>
  </main>;
}
