// Two-tone incoming-call ring, synthesised with Web Audio (no audio files).
// Returns a stop function; safe to call in a renderer without Web Audio.
export function startRingtone(win, { intervalMs = 3000 } = {}) {
  const AudioContextClass = win?.AudioContext || win?.webkitAudioContext;
  if (typeof AudioContextClass !== 'function') return () => {};
  let context;
  try { context = new AudioContextClass(); } catch { return () => {}; }
  try { Promise.resolve(context.resume?.()).catch(() => {}); } catch { /* autoplay policy: the ring stays silent */ }
  let timer = null;
  let stopped = false;
  const tone = (at, hertz) => {
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(hertz, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.42);
    } catch { /* a closed context stays silent */ }
  };
  const ring = () => {
    if (stopped) return;
    const now = context.currentTime;
    tone(now, 440);
    tone(now + 0.45, 480);
  };
  ring();
  timer = setInterval(ring, intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    try { context.close(); } catch { /* already closed */ }
  };
}

// Soft two-note chime for a colleague joining the call. Never throws: a
// window without audio (or a blocked context) just stays silent.
export function playJoinChime(win) {
  try {
    const AudioContextClass = win?.AudioContext || win?.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') return;
    const context = new AudioContextClass();
    try { Promise.resolve(context.resume?.()).catch(() => {}); } catch { /* autoplay policy: the chime stays silent */ }
    const now = context.currentTime;
    [[660, 0], [880, 0.14]].forEach(([hertz, offset]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = now + offset;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(hertz, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.32);
    });
    setTimeout(() => { try { context.close(); } catch { /* already closed */ } }, 800);
  } catch { /* no audio available */ }
}
