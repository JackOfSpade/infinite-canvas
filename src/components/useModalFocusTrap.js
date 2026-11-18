import { useCallback, useEffect } from 'react';
import { updateModalCount } from './modalStack';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Shared keyboard behaviour for a modal dialog rendered in a portal. While the
 * dialog is mounted it counts as an open modal (so global shortcuts go quiet),
 * focus starts on `initialFocusRef` and returns to the control that opened the
 * dialog when it closes. The returned handler goes on the dialog's `onKeyDown`
 * and keeps Tab inside the dialog.
 */
export function useModalFocusTrap(dialogRef, initialFocusRef) {
  useEffect(() => {
    updateModalCount(1);
    const previous = document.activeElement;
    initialFocusRef?.current?.focus();
    return () => {
      updateModalCount(-1);
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    };
  }, [initialFocusRef]);

  return useCallback((event) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    const elements = dialog ? [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)] : [];
    if (elements.length === 0) {
      event.preventDefault();
      dialog?.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [dialogRef]);
}
