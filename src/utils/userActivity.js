// When the person last moved, clicked, scrolled or typed. Auto-save uses it to
// wait for a pause: sending a large canvas to be saved briefly blocks the
// window, and that should not land in the middle of a drag or a scroll.
let lastInputAt = 0;
let listening = false;

function noteInput() {
  lastInputAt = Date.now();
}

function ensureListening() {
  if (listening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listening = true;
  const options = { capture: true, passive: true };
  for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
    window.addEventListener(type, noteInput, options);
  }
}

/** Milliseconds since the last input; Infinity when there has been none. */
export function msSinceUserInput(now = Date.now()) {
  ensureListening();
  return lastInputAt ? Math.max(0, now - lastInputAt) : Infinity;
}

ensureListening();
