// Persona display helpers shared by the call screens.
export function initialsOf(persona) {
  const given = String(persona?.initials || '').trim();
  if (given) return given.slice(0, 3).toUpperCase();
  const words = String(persona?.name || '').trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return '??';
  return words.slice(0, 2).map(word => word[0].toUpperCase()).join('');
}

export function roleLine(persona) {
  return [persona?.role, persona?.team].filter(Boolean).join(' · ');
}
