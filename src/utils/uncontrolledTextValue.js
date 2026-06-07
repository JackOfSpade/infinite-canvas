export function syncUncontrolledTextValue(element, externalValue, focused = false) {
  if (!element || focused) return false;

  const nextValue = String(externalValue ?? '');
  if (element.value === nextValue) return false;

  element.value = nextValue;
  return true;
}
