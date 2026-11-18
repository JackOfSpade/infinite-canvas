// Persona display helpers shared by the call screens.
export function roleLine(persona) {
  return [persona?.role, persona?.team].filter(Boolean).join(' · ');
}

// Solid colours that keep white text readable on the dark call background.
export const AVATAR_PALETTE = Object.freeze([
  '#7b1fa2', '#1a73e8', '#00796b', '#c2185b', '#e8710a',
  '#5f6bc0', '#2e7d32', '#ad1457', '#00838f', '#6d4c41',
]);
export const NEUTRAL_AVATAR_COLOR = '#5f6368';

// A video call shows someone with no photo as one letter on a colour. The
// colour comes from a stable hash of the name so the same person always looks
// the same, on every screen and in every call.
export function avatarOf(person) {
  const name = String(person?.name || '').trim();
  if (!name) return { letter: '', color: NEUTRAL_AVATAR_COLOR };
  const first = Array.from(name.split(/\s+/u)[0])[0] || '';
  let hash = 5381;
  for (const char of name.toLowerCase()) hash = ((hash * 33) ^ char.codePointAt(0)) >>> 0;
  return { letter: first.toUpperCase(), color: AVATAR_PALETTE[hash % AVATAR_PALETTE.length] };
}

export const firstNameOf = person => String(person?.name || '').trim().split(/\s+/u)[0] || '';

// The interviewers of a call as the screens list them: the service's
// participants when it sends them, otherwise the single lead from persona.
export function participantsOf(state) {
  const list = Array.isArray(state?.participants) ? state.participants.filter(item => item && typeof item === 'object') : [];
  if (list.length) return list;
  return [{ id: 'A', name: state?.persona?.name || '', role: state?.persona?.role || '', team: state?.persona?.team || '', status: 'joined' }];
}

// Who spoke a replay turn: the panel on the replay object lists the
// colleagues, the lead is the persona.
export function replaySpeakerName(replay, speakerId) {
  if (!speakerId) return 'Interviewer';
  const panel = Array.isArray(replay?.panel) ? replay.panel : [];
  const found = panel.find(item => item?.id === speakerId);
  if (found?.name) return found.name;
  if (replay?.persona?.name && (speakerId === 'A' || !panel.length)) return replay.persona.name;
  return 'Interviewer';
}
