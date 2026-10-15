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
  const timerRef = useRef(null);

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Unmount cleanup so a pending auto-disarm never fires on a dead component.
  useEffect(() => () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleClick = (event) => {
    event.stopPropagation();
    if (disabled) return;
    if (!armed) {
      setArmed(true);
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setArmed(false);
      }, timeoutMs);
      return;
    }
    clearTimer();
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
