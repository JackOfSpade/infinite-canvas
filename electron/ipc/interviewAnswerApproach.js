/**
 * Approach reminders: how to answer a "how do you work" interview question.
 *
 * Questions such as "How do you work under pressure?" ask for a way of
 * working, not for one past event. For those the live card shows two or three
 * short imperative reminders ("Split work into small tasks") that the person
 * illustrates with a real example of their own while speaking.
 *
 * A reminder is general good practice, never a statement about the person: the
 * host refuses first-person wording, numbers and names, so a reminder cannot
 * assert that something happened. It may point at ONE existing prepared line of
 * the same card as its example; the pointer is an id of that line, so the model
 * can select a validated line but cannot write a new claim.
 */
import { glanceWordCount } from '../../src/utils/interviewGlanceCue.js';

const CARDS_PER_CALL = 40;
// Three at most: read in a glance, and one real example has to fit them all.
export const APPROACH_MAX_REMINDERS = 3;
export const APPROACH_MAX_WORDS = 8;
export const APPROACH_MAX_CHARS = 70;
export const APPROACH_LIST_MAX_WORDS = 16;
export const APPROACH_LIST_MAX_CHARS = 120;

export const INTERVIEW_APPROACH_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['cards'],
  properties: { cards: { type: 'array', maxItems: CARDS_PER_CALL, items: {
    type: 'object', additionalProperties: false, required: ['id', 'reminders'],
    properties: { id: { type: 'string' }, reminders: { type: 'array', maxItems: APPROACH_MAX_REMINDERS, items: {
      type: 'object', additionalProperties: false, required: ['text', 'exampleLine'],
      properties: { text: { type: 'string', maxLength: APPROACH_MAX_CHARS }, exampleLine: { type: 'string', maxLength: 40 } },
    } } },
  } } },
});

export function interviewApproachPrompt(units) {
  return `For each interview QUESTION below, decide whether it asks HOW the candidate works (a habit, method or attitude, for example handling pressure, disagreement, feedback, priorities, ambiguity, change, mistakes, teamwork or planning) or asks for something else (their background, one named project, a result, why this role or company, facts about their experience).
For a HOW question return 2–${APPROACH_MAX_REMINDERS} reminders. For any other question return an empty reminders list.
A REMINDER is widely accepted good practice for answering that question, written so the candidate can glance at it mid-interview and then tell a real example of their own. Use what interviewers are known to look for in a strong answer to that question.
REMINDER FORMAT: an instruction starting with a verb, 2–${APPROACH_MAX_WORDS} words, at most ${APPROACH_MAX_CHARS} characters, no final period. Example of the form only: "Split work into small tasks". Each reminder of one card is a different idea, most useful first.
NEVER describe the candidate: no "I", "we", "my" or "our", no past-tense account of something done, no employer, product, person or technology name, and no number. A reminder states a way of working that anyone could follow; the candidate supplies what actually happened.
EXAMPLE LINE: each question lists the candidate's already prepared answer lines with an id. When one of those lines is a real instance of a reminder, put that line's id in exampleLine; otherwise use an empty string. Use a line id at most once per card, never invent an id, and never restate the line in the reminder.
Return JSON {cards:[{id,reminders:[{text,exampleLine}]}]} with exactly one entry for every question id.
QUESTIONS:
${JSON.stringify(units.map(({ id, question, lines }) => ({ id, question, lines: lines.map(line => ({ id: line.id, text: line.text })) })))}`;
}

/** Why a returned reminder cannot be kept, or null when it can. */
export function approachReminderFailure(value, { generalKnowledge = false, definition = false } = {}) {
  if (typeof value !== 'string') return 'not text';
  const text = value.trim();
  if (!text || /[\r\n\t]/u.test(text)) return 'empty or multi-line';
  // A named list the question asks for ("ACID: atomicity, consistency, ...")
  // is one point however many items it has, so it alone may run longer.
  const namedList = generalKnowledge && /^[^:,]{1,40}:\s+[^:,]+(?:,\s*[^:,]+){2,}$/u.test(text.replace(/[.!?]+$/u, ''));
  const [maxChars, maxWords] = namedList ? [APPROACH_LIST_MAX_CHARS, APPROACH_LIST_MAX_WORDS] : [APPROACH_MAX_CHARS, APPROACH_MAX_WORDS];
  if (text.length > maxChars || glanceWordCount(text) > maxWords || glanceWordCount(text) < 2) return 'wrong length';
  if (/\b(?:I|we|my|our|me|us|mine|ours)\b/iu.test(text) || /\bI['’]/u.test(text)) return 'describes the candidate';
  // Live talking points may state general knowledge (a technology, a named
  // method, a figure everyone can check); prepared reminders may not.
  if (!generalKnowledge && /\d/u.test(text)) return 'contains a number';
  // A capital after the first word is a name; reminders are generic practice.
  if (!generalKnowledge && /\s\p{Lu}/u.test(text)) return 'contains a name';
  if (/[!?;]/u.test(text.replace(/[.!?]+$/u, '')) || (namedList || definition ? /\.(?:\s|$)/u : /[.:](?:\s|$)/u).test(text.replace(/[.!?]+$/u, ''))) return 'more than one statement';
  return null;
}

/**
 * Ask for approach reminders for `units` ([{ id, question, lines:[{id,text}] }]).
 * Returns a Map of unit id to [{ text, example }] where `example` is the exact
 * text of the prepared line chosen as the example, or ''. Every answered unit
 * is present; an empty list means "not a how-do-you-work question".
 */
export async function generateInterviewApproaches({ units, callText, signal, logWarning = () => {} }) {
  const wanted = (units || []).filter(unit => unit && typeof unit.id === 'string' && typeof unit.question === 'string' && unit.question.trim());
  const kept = new Map();
  for (let start = 0; start < wanted.length; start += CARDS_PER_CALL) {
    const batch = wanted.slice(start, start + CARDS_PER_CALL).map(unit => ({ ...unit, lines: Array.isArray(unit.lines) ? unit.lines : [] }));
    const byId = new Map(batch.map(unit => [unit.id, unit]));
    const reply = await callText(interviewApproachPrompt(batch), {
      signal, task: 'interview-answer-bank', claudeStage: 'qa-approach-reminders', responseSchema: INTERVIEW_APPROACH_SCHEMA,
    });
    let dropped = 0;
    for (const item of Array.isArray(reply?.cards) ? reply.cards : []) {
      const unit = byId.get(item?.id);
      if (!unit || kept.has(unit.id)) continue;
      const reminders = []; const usedLines = new Set(); const seen = new Set();
      for (const reminder of Array.isArray(item.reminders) ? item.reminders : []) {
        if (reminders.length === APPROACH_MAX_REMINDERS) break;
        if (approachReminderFailure(reminder?.text)) { dropped += 1; continue; }
        const text = reminder.text.trim().replace(/[.!?]+$/u, '');
        if (seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        const line = unit.lines.find(candidate => candidate.id === reminder.exampleLine && !usedLines.has(candidate.id));
        if (line) usedLines.add(line.id);
        reminders.push({ text, example: line ? line.text : '' });
      }
      // One surviving reminder is not an approach; treat it as none.
      kept.set(unit.id, reminders.length >= 2 ? reminders : []);
    }
    if (dropped) logWarning(`[Interview Q&A] ${dropped} approach reminders were dropped by the wording check.`);
  }
  return kept;
}
