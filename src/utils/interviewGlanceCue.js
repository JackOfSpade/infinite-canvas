/**
 * Glance cues for the live interview card.
 *
 * During a call the person cannot click or read sentences. Each prepared line
 * is shown as a short reminder: the saved AI-written `cue` when one exists,
 * otherwise the line itself with its sentence scaffolding removed. The full
 * sentence always stays available (hover title, Sources, Copy answer, Edit Q&A).
 */
export const GLANCE_CUE_MAX_WORDS = 9;
export const GLANCE_CUE_MAX_CHARS = 90;
/** Lines this short are already a reminder and need no separate cue. */
export const GLANCE_CUE_SHORT_LINE_WORDS = 6;

export const glanceWordCount = value => String(value || '').trim().split(/\s+/u).filter(Boolean).length;

/** Sentence scaffolding removed; no word of the line is replaced or invented. */
export function fallbackGlanceCue(value) {
  let cue = String(value || '').replace(/\s+/gu, ' ').trim().replace(/[.!]+$/u, '');
  // "As <title> at <employer>, I built ..." and "At <employer>, I built ..."
  // lead with the employer, which is the part that tells two stories apart.
  cue = cue.replace(/^as\s+[^,]+?\s+at\s+([^,]+),\s+(I|we)\s+/iu, (_, place, who) => `${place}: ${/^we$/iu.test(who) ? 'we ' : ''}`)
    .replace(/^at\s+([^,]+),\s+(I|we)\s+/iu, (_, place, who) => `${place}: ${/^we$/iu.test(who) ? 'we ' : ''}`)
    .replace(/^I(?:\s+am|[’']m)?\s+/u, '');
  return cue.replace(/(^|\s)(?:a|an|the)\s+/giu, '$1').trim();
}

/**
 * A reminder without its leading employer when that employer is the most
 * recent one. Nearly every line comes from the most recent role, so naming it
 * on each line is noise; a line that still names an employer is an earlier role.
 */
export function withoutRecentEmployer(cue, recentEmployer) {
  const employer = typeof recentEmployer === 'string' ? recentEmployer.trim() : '';
  const value = String(cue || '');
  if (!employer || value.length <= employer.length || value.slice(0, employer.length).toLowerCase() !== employer.toLowerCase()) return value;
  const rest = value.slice(employer.length);
  const separator = /^\s*[:,·–—-]\s+/u.exec(rest);
  return separator && rest.slice(separator[0].length).trim() ? rest.slice(separator[0].length).trim() : value;
}

/** The reminder to show for one prepared line. */
export function glanceCueOf(text, cue, recentEmployer = '') {
  const saved = typeof cue === 'string' ? cue.trim() : '';
  return withoutRecentEmployer(saved || fallbackGlanceCue(text), recentEmployer);
}
