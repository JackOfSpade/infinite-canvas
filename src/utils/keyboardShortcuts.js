export function matchesShortcut(event, binding) {
  if (!binding) return false;
  const isMod = event.ctrlKey || event.metaKey;
  if (binding.meta && !isMod) return false;
  if (!binding.meta && isMod) return false;
  if (!!binding.shift !== !!event.shiftKey) return false;
  if (!!binding.alt !== !!event.altKey) return false;
  return event.key.toLowerCase() === binding.key.toLowerCase();
}

const STANDARD_REDO_SHORTCUTS = [
  { meta: true, shift: false, alt: false, key: 'y' },
  { meta: true, shift: true, alt: false, key: 'z' },
];

export function matchesStandardRedoShortcut(event) {
  return STANDARD_REDO_SHORTCUTS.some(binding => matchesShortcut(event, binding));
}

export function matchesRedoShortcut(event, shortcuts = {}) {
  return matchesStandardRedoShortcut(event)
    || matchesShortcut(event, shortcuts.redo)
    || matchesShortcut(event, shortcuts.redoAlt);
}
