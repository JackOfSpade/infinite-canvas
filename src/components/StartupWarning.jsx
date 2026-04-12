import React, { useState } from 'react';
import { Dialog } from './Dialog';

/**
 * First-launch warning about file linking behavior.
 * Shows once, can be dismissed permanently via "Don't show again" checkbox.
 */
export function StartupWarning() {
  const [visible, setVisible] = useState(() => {
    return localStorage.getItem('hideStartupWarning') !== 'true';
  });
  const [dontShowAgain, setDontShowAgain] = useState(false);

  if (!visible) return null;

  return (
    <Dialog title="Heads Up" onClose={() => { }} width="w-96">
      <p className="text-white/70 text-sm leading-relaxed">
        Files dropped into the canvas are not copies. Any content edits will be reflected in your actual linked file.
      </p>
      <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={dontShowAgain}
          onChange={(e) => setDontShowAgain(e.target.checked)}
          className="rounded border-white/20 bg-black/40 accent-blue-500"
        />
        <span className="text-white/50 text-sm">Don't show again</span>
      </label>
      <button
        className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 mt-3 font-medium transition-colors w-full"
        onClick={() => {
          if (dontShowAgain) {
            localStorage.setItem('hideStartupWarning', 'true');
          }
          setVisible(false);
        }}
      >
        Okay
      </button>
    </Dialog>
  );
}
