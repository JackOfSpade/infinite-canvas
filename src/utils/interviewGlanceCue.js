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

/** The reminder to show for one prepared line. */
export function glanceCueOf(text, cue) {
  const saved = typeof cue === 'string' ? cue.trim() : '';
  return saved || fallbackGlanceCue(text);
}
