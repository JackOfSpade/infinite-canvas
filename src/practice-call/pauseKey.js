// Decides whether a keydown is the hidden pause shortcut. Kept out of the
// component so the decision can be tested without a DOM.

/** True when the key press lands in something the user types into. */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

// Bare P only counts outside editable fields (the chat box and the coding pad
// must type the letter). Command or Control plus P works from anywhere, so a
// typist can pause without leaving the box.
export function shouldTogglePause(event) {
  if (!event || event.repeat || event.altKey || event.shiftKey) return { toggle: false, preventDefault: false };
  if (String(event.key ?? '').toLowerCase() !== 'p') return { toggle: false, preventDefault: false };
  if (event.metaKey || event.ctrlKey) return { toggle: true, preventDefault: true };
  return { toggle: !isEditableTarget(event.target), preventDefault: false };
}
