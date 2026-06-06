export const NATIVE_TEXT_UNDO_ATTR = 'data-native-undo';

const TEXT_INPUT_TYPES = new Set([
  '',
  'date',
  'datetime-local',
  'email',
  'month',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'time',
  'url',
  'week',
]);

function elementFromTarget(target) {
  if (!target) return null;
  if (target.nodeType === 1) return target;
  return target.parentElement || null;
}

export function isTextEditingTarget(target) {
  const el = elementFromTarget(target);
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
}

export function shouldUseNativeTextUndo(target) {
  const el = elementFromTarget(target);
  if (!el || !isTextEditingTarget(el)) return false;
  return !!el.closest?.(`[${NATIVE_TEXT_UNDO_ATTR}="true"]`);
}
