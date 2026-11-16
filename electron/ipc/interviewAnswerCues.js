/**
 * Glance cues: a short reminder for each prepared interview answer line.
 *
 * The validated sentence stays the source of truth. A cue only selects words
 * from its own line, so it cannot add a claim: the host keeps a cue only when
 * every content word of it already occurs in that line. A cue that fails is
 * dropped on its own and the live card falls back to the trimmed line.
 */
import { GLANCE_CUE_MAX_CHARS, GLANCE_CUE_MAX_WORDS, GLANCE_CUE_SHORT_LINE_WORDS, glanceWordCount } from '../../src/utils/interviewGlanceCue.js';
import { interviewClaimContent } from './interviewSpokenClaims.js';

const UNITS_PER_CALL = 120;

export const INTERVIEW_GLANCE_CUE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['cues'],
  properties: { cues: { type: 'array', maxItems: UNITS_PER_CALL, items: {
    type: 'object', additionalProperties: false, required: ['id', 'cue'],
    properties: { id: { type: 'string' }, cue: { type: 'string', maxLength: GLANCE_CUE_MAX_CHARS } },
  } } },
});

/** True when a line is long enough to need a separate reminder. */
export const needsGlanceCue = text => glanceWordCount(text) > GLANCE_CUE_SHORT_LINE_WORDS;

export function interviewGlanceCuePrompt(units) {
  return `Write one glance cue for each LINE below. The lines are prepared interview answer sentences. During the live interview the candidate has under a second to look at the screen, cannot click anything, and will speak in their own words: the cue only has to remind them which story and which point this line is.
CUE FORMAT: 2–${GLANCE_CUE_MAX_WORDS - 2} words is the target, never more than ${GLANCE_CUE_MAX_WORDS} words or ${GLANCE_CUE_MAX_CHARS} characters. Note form, not a sentence: no "I", no articles, no filler verbs, no final period. Join parts with a colon, comma or "·".
WHAT TO KEEP: lead with the word that tells this line apart from the other lines of the same card, usually the employer, project, product or number; then the one action or result. Keep every number with its unit. Keep a word that says the work was shared, inherited, supporting or approximate (for example we, helped, maintained, about) when the line has one, so the reminder does not suggest more than the line says.
WORDS: use only words that already occur in that same line, in the same spelling apart from grammatical endings. Do not abbreviate, rename, translate or add anything, and do not borrow a word from another line.
Cues of one card (the id before the dot) must differ from each other. Return JSON {cues:[{id,cue}]} with exactly one entry for every line id.
LINES:
${JSON.stringify(units.map(({ id, text }) => ({ id, text })))}`;
}

/** Why a returned cue cannot be kept, or null when it can. */
export function glanceCueFailure(cue, text) {
  if (typeof cue !== 'string') return 'not text';
  const value = cue.trim();
  if (!value || /[\r\n\t]/u.test(value)) return 'empty or multi-line';
  if (value.length > GLANCE_CUE_MAX_CHARS || glanceWordCount(value) > GLANCE_CUE_MAX_WORDS) return 'too long';
  if (glanceWordCount(value) >= glanceWordCount(text)) return 'not shorter than its line';
  const allowed = new Set(interviewClaimContent(text));
  const added = interviewClaimContent(value).filter(token => !allowed.has(token));
  return added.length ? `adds ${JSON.stringify(added)}` : null;
}

/**
 * Ask for cues for `units` ([{ id, text }]) and keep the valid ones.
 * Returns a Map of unit id to cue; a missing id means "no cue".
 */
export async function generateInterviewGlanceCues({ units, callText, signal, logWarning = () => {} }) {
  const wanted = (units || []).filter(unit => unit && typeof unit.id === 'string' && typeof unit.text === 'string' && needsGlanceCue(unit.text));
  const kept = new Map();
  for (let start = 0; start < wanted.length; start += UNITS_PER_CALL) {
    const batch = wanted.slice(start, start + UNITS_PER_CALL);
    const byId = new Map(batch.map(unit => [unit.id, unit]));
    const reply = await callText(interviewGlanceCuePrompt(batch), {
      signal, task: 'interview-answer-bank', claudeStage: 'qa-glance-cues', responseSchema: INTERVIEW_GLANCE_CUE_SCHEMA,
    });
    let dropped = 0;
    for (const item of Array.isArray(reply?.cues) ? reply.cues : []) {
      const unit = byId.get(item?.id);
      if (!unit || kept.has(unit.id)) continue;
      if (glanceCueFailure(item.cue, unit.text)) { dropped += 1; continue; }
      kept.set(unit.id, item.cue.trim());
    }
    if (dropped) logWarning(`[Interview Q&A] ${dropped} of ${batch.length} glance cues were dropped by the word check; those lines show trimmed text.`);
  }
  return kept;
}
