import { useState, useRef, useEffect } from 'react';

/**
 * Mirrors a remote (prop/data) value into local state, but pauses sync while
 * the user is interacting with the input. Returned helpers attach the focus
 * tracking to the underlying field so external updates (undo/redo, async
 * regeneration) don't clobber an in-flight edit.
 *
 * Effect-based sync rather than render-phase: render-phase ref reads are
 * disallowed by react-hooks/refs, and we genuinely need to consult focus
 * state at sync time. The setValue call inside the effect is intentional.
 *
 *   const { value, setValue, focusProps } = useSyncWhileFocused(data.notes ?? '');
 *   <textarea value={value} onChange={e => setValue(e.target.value)} {...focusProps} />
 */
export function useSyncWhileFocused(externalValue) {
  const [value, setValue] = useState(externalValue);
  const focusRef = useRef(false);

  useEffect(() => {
    if (!focusRef.current) setValue(externalValue);
  }, [externalValue]);

  const focusProps = {
    onFocus: () => { focusRef.current = true; },
    onBlur: () => { focusRef.current = false; },
  };

  return { value, setValue, focusProps, focusRef };
}
