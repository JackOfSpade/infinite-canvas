import React, { useEffect, useRef, useState } from 'react';

// Destructive-action button that needs two deliberate clicks: the first arms it
// (label swaps to `confirmLabel`), the second within `timeoutMs` confirms. An
// armed button quietly reverts on its own so a stray first click is harmless.
// Used instead of a blocking browser dialog, which would freeze the canvas.
// `armedClassName` REPLACES `className` while armed (Tailwind resolves two
// conflicting utilities by stylesheet order, not class order), so pass the
// full armed class list including layout.
export function TwoStepConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = '',
  armedClassName = '',
  title,
  disabled = false,
  timeoutMs = 4000,
}) {
  const [armed, setArmed] = useState(false);
  const [wasDisabled, setWasDisabled] = useState(disabled);
  const timerRef = useRef(null);
  const armedUntilRef = useRef(0);

  // Reset during the prop transition so an unlock never paints a stale prompt.
  if (wasDisabled !== disabled) {
    setWasDisabled(disabled);
    setArmed(false);
  }

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Locking the owner invalidates its pending confirmation. A later unlock
  // must always require two fresh clicks, even if the old timer has not fired.
  useEffect(() => {
    if (disabled) {
      armedUntilRef.current = 0;
    }
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [disabled]);

  const handleClick = (event) => {
    event.stopPropagation();
    if (disabled) return;
    // Timers can be delayed while Electron is suspended or its main thread is
    // busy. Check the deadline as well so an expired confirmation cannot run.
    if (!armed || Date.now() >= armedUntilRef.current) {
      setArmed(true);
      clearTimer();
      const duration = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 4000;
      armedUntilRef.current = Date.now() + duration;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        armedUntilRef.current = 0;
        setArmed(false);
      }, duration);
      return;
    }
    clearTimer();
    armedUntilRef.current = 0;
    setArmed(false);
    onConfirm?.(event);
  };

  const isArmed = armed && !disabled;

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={(event) => event.stopPropagation()}
      disabled={disabled}
      aria-live="polite"
      className={`nodrag ${isArmed && armedClassName ? armedClassName : className}`}
      title={title}
    >
      {isArmed ? confirmLabel : label}
    </button>
  );
}
