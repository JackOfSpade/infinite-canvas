/** Order the reversible part of Quit before any window is destroyed. */
export function createQuitAutosaveAttempt({
  windows, beginPause, releasePause, holdBridge, resumeBridge,
  pauseRenderer, drainSender, flushPersistence, freezeRenderer,
  saveRenderer, releaseRenderer, windowsAreCurrent,
}) {
  const gated = new Set();
  const attempted = new Set();
  let released = false;
  return {
    async run() {
      // No await until every sender rejects new work.
      for (const win of windows) {
        gated.add(win);
        beginPause(win);
      }
      const held = await holdBridge();
      if (held?.success !== true) throw new Error('Could not pause the application handoff bridge.');
      const paused = new Map();
      for (const win of windows) {
        attempted.add(win);
        const result = await pauseRenderer(win);
        if (result?.success !== true) throw new Error('Could not pause and checkpoint an active canvas.');
        paused.set(win, result);
      }
      for (const win of windows) {
        const result = await drainSender(win);
        if (result?.settled !== true) throw new Error('Active work has not finished pausing.');
      }
      await flushPersistence();
      if (!windowsAreCurrent()) throw new Error('The open canvas windows changed during quit.');
      // Paused recovery and terminal publications must commit before mutation
      // gates close. The final save then reads one stable snapshot per window.
      for (const win of windows) {
        if (!await freezeRenderer(win)) throw new Error('Could not freeze a canvas for saving.');
      }
      for (const win of windows) {
        if (!await saveRenderer(win, paused.get(win))) return false;
        if (!windowsAreCurrent()) throw new Error('The open canvas windows changed while saving.');
      }
      return true;
    },
    async release() {
      if (released) return;
      released = true;
      // Always release every renderer that might have received a request,
      // including a timed-out request whose acknowledgement never arrived.
      const failures = [];
      for (const win of attempted) {
        try { releaseRenderer(win); } catch (error) { failures.push(error); }
      }
      for (const win of gated) {
        try { releasePause(win); } catch (error) { failures.push(error); }
      }
      try {
        const resumed = await resumeBridge();
        if (resumed?.success !== true) throw new Error('The application handoff bridge is still paused.');
      } catch (error) { failures.push(error); }
      if (failures.length) throw new Error('Could not fully release the quit pause.', { cause: failures[0] });
    },
  };
}
