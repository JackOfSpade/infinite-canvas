/**
 * Practice mode for the Interview Helper: the app runs the call in its own
 * practice window and the feedback arrives over the in-app transport.
 *
 * At setup an AI call plans a realistic interview order over every Foundation
 * and company question. A practice run is armed with a one-shot session code,
 * which binds the recorded call (and its feedback) to that run. This module
 * holds the codes, the order planning and the feedback validation the call
 * and the registry share.
 */
import crypto from 'node:crypto';
import { normalizeQuestion } from './interviewQaStore.js';

export const PRACTICE_MAX_QUESTIONS = 40;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 20;
export const PRACTICE_CODE_RE = /^PRACTICE-[2-9A-HJ-NP-Z]{20}$/u;
const INTRO = normalizeQuestion('Tell me about yourself.');

const LIMITS = Object.freeze({
  text: 600, long: 1500, short: 300, transcriptText: 4000, transcript: 200, planned: PRACTICE_MAX_QUESTIONS, moments: 30, priorities: 5,
});
export const PRACTICE_FEEDBACK_LIMITS = LIMITS;
export const PRACTICE_MOMENT_KINDS = Object.freeze(['small-talk', 'curveball', 'off-topic', 'follow-up', 'questions-for-interviewer', 'closing', 'other']);

export function newPracticeCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) out += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  return `PRACTICE-${out}`;
}
export const practiceCodeHash = code => crypto.createHash('sha256').update(String(code)).digest('hex');

// ------------------------------------------------------------------ order --

export const INTERVIEW_PRACTICE_ORDER_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['order'],
  properties: { order: { type: 'array', maxItems: PRACTICE_MAX_QUESTIONS, items: { type: 'integer', minimum: 0, maximum: PRACTICE_MAX_QUESTIONS - 1 } } },
});

export function interviewPracticeOrderPrompt({ questions, company }) {
  return `Plan the order an interviewer at ${JSON.stringify(company || 'this company')} would most plausibly ask these questions in one practice interview. Use every question exactly once. Follow a natural interview arc: an introduction first, motivation (why this role/company) early, experience, projects and behavioral questions in the middle, technical or role-specific questions after rapport is built, and closing or reflective questions last. Within each phase, vary the order the way a real interviewer would rather than listing questions in their given order. Return {"order":[index,...]} using the indices below.\nQUESTIONS:\n${JSON.stringify(questions.map((question, index) => ({ index, question })))}`;
}

/** The order must use every index once and never leave the introduction late. */
export function validatePracticeOrder(value, questions) {
  const order = Array.isArray(value?.order) ? value.order : null;
  if (!order) throw new Error('order-shape: return {"order":[...]} with every index once.');
  const indices = new Set(order);
  if (order.length !== questions.length || indices.size !== questions.length || order.some(index => !Number.isInteger(index) || index < 0 || index >= questions.length)) {
    throw new Error(`order-permutation: use each index 0..${questions.length - 1} exactly once.`);
  }
  const intro = questions.findIndex(question => normalizeQuestion(question) === INTRO);
  if (intro >= 0 && order[0] !== intro) throw new Error(`order-intro: the introduction (index ${intro}) must be asked first.`);
  return order;
}

export async function planInterviewPracticeOrder({ questions, company, callText, signal }) {
  const byKey = new Map();
  for (const item of questions) if (typeof item === 'string' && item.trim() && !byKey.has(normalizeQuestion(item))) byKey.set(normalizeQuestion(item), item.trim());
  const unique = [...byKey.values()].slice(0, PRACTICE_MAX_QUESTIONS);
  if (unique.length < 2) return unique;
  const reply = await callText(interviewPracticeOrderPrompt({ questions: unique, company }), {
    signal, task: 'interview-qa-practice', claudeStage: 'qa-brief', responseSchema: INTERVIEW_PRACTICE_ORDER_SCHEMA,
    responseValidator: value => validatePracticeOrder(value, unique),
  });
  return validatePracticeOrder(reply, unique).map(index => unique[index]);
}

/** Put saved order first, then any card the plan does not know yet. */
export function orderPracticeQuestions(cards, savedOrder = []) {
  const byKey = new Map();
  for (const card of cards || []) if (typeof card?.question === 'string' && card.question.trim() && !byKey.has(normalizeQuestion(card.question))) byKey.set(normalizeQuestion(card.question), card);
  const ordered = [];
  for (const question of savedOrder || []) { const card = byKey.get(normalizeQuestion(question)); if (card) { ordered.push(card); byKey.delete(normalizeQuestion(question)); } }
  return [...ordered, ...byKey.values()].slice(0, PRACTICE_MAX_QUESTIONS);
}

// --------------------------------------------------------------- feedback --

const scoreSchema = { type: 'integer', minimum: 1, maximum: 10 };
const str = max => ({ type: 'string', maxLength: max });

// A post-call analysis names the recording it came from by its call id.
export const PRACTICE_CALL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
/** Delivery notes from a post-call review; every number cites the call metrics. */
export const INTERVIEW_PRACTICE_DELIVERY_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['summary'],
  properties: {
    summary: { ...str(LIMITS.long), description: 'How the call was delivered: pace, pauses, fillers, confidence, interruptions and typed answers, citing the measured numbers.' },
    pace: str(LIMITS.short), pauses: str(LIMITS.short), fillers: str(LIMITS.short), confidence: str(LIMITS.short),
    interruptions: str(LIMITS.short), typedAnswers: str(LIMITS.short),
    fillerCount: { type: 'integer', minimum: 0, description: 'Counted from the verbatim transcript; only non-lexical filler uses.' },
    wordsPerMinute: { type: 'number', description: 'From the deterministic metrics, never estimated.' },
  },
});
export const INTERVIEW_PRACTICE_FEEDBACK_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['session', 'overall', 'planned', 'priorities'],
  properties: {
    session: { type: 'string', description: 'The practice session code from the starter message.' },
    overall: { type: 'object', additionalProperties: false, required: ['score', 'summary'], properties: { score: scoreSchema, summary: str(LIMITS.long) }, description: 'The whole call, not only the planned questions.' },
    planned: { type: 'array', maxItems: LIMITS.planned, items: { type: 'object', additionalProperties: false, required: ['question', 'asked'], properties: {
      question: str(LIMITS.short), asked: { type: 'boolean' }, askedAs: str(LIMITS.short), score: { ...scoreSchema, description: 'Only for questions you asked; omit it for unasked ones.' },
      covered: str(LIMITS.text), adapted: str(LIMITS.text), improve: str(LIMITS.text),
      extension: { ...str(LIMITS.text), description: 'Optional extension: material beyond the memorized prepared answer that would have answered more completely, phrased as something to consider next time, never required.' },
    } }, description: 'One entry per planned question, question copied from the plan.' },
    moments: { type: 'array', maxItems: LIMITS.moments, items: { type: 'object', additionalProperties: false, required: ['kind', 'prompt'], properties: {
      kind: { type: 'string', enum: [...PRACTICE_MOMENT_KINDS] }, prompt: str(LIMITS.short), score: scoreSchema, note: str(LIMITS.text),
    } }, description: 'Unplanned parts of the call: small talk, curveballs, off-topic moments, follow-ups, my questions for you, the closing.' },
    communication: { type: 'object', additionalProperties: false, properties: { pace: str(LIMITS.short), clarity: str(LIMITS.short), structure: str(LIMITS.short), confidence: str(LIMITS.short), filler: str(LIMITS.short) } },
    priorities: { type: 'array', maxItems: LIMITS.priorities, items: str(LIMITS.short), description: 'The few things to work on first, most important first.' },
    transcript: { type: 'array', maxItems: LIMITS.transcript, items: { type: 'object', additionalProperties: false, required: ['role', 'text'], properties: { role: { type: 'string', enum: ['interviewer', 'candidate'] }, text: str(LIMITS.transcriptText) } } },
    callId: { ...str(64), pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'The practice call this feedback analyses, when it came from a recorded call.' },
    delivery: INTERVIEW_PRACTICE_DELIVERY_SCHEMA,
  },
});

const hasControl = value => { for (const char of String(value)) { const code = char.codePointAt(0); if (code < 0x20 && code !== 0x0a && code !== 0x09) return true; if (code === 0x7f) return true; } return false; };
const bounded = (value, max, field) => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || hasControl(value)) throw new Error(`${field} must be a string of at most ${max} characters.`);
  return value.trim();
};
const score = (value, field) => {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error(`${field} must be an integer from 1 to 10.`);
  return value;
};
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const callIdValue = value => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !PRACTICE_CALL_ID_RE.test(value)) throw new Error('callId must be 1-64 letters, digits, hyphens or underscores.');
  return value;
};
const count = (value, field) => {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a whole number of zero or more.`);
  return value;
};
const rate = (value, field) => {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) throw new Error(`${field} must be a number from 0 to 1000.`);
  return value;
};

/** Optional delivery notes from the post-call review; every field is bounded. */
function deliveryNotes(input) {
  if (input === undefined) return null;
  if (!plain(input)) throw new Error('delivery must be an object.');
  const out = {};
  for (const key of ['summary', 'pace', 'pauses', 'fillers', 'confidence', 'interruptions', 'typedAnswers']) {
    const value = bounded(input[key], key === 'summary' ? LIMITS.long : LIMITS.short, `delivery.${key}`);
    if (key === 'summary' && !value) throw new Error('delivery.summary is required.');
    if (value) out[key] = value;
  }
  const fillerCount = count(input.fillerCount, 'delivery.fillerCount');
  if (fillerCount !== null) out.fillerCount = fillerCount;
  const wordsPerMinute = rate(input.wordsPerMinute, 'delivery.wordsPerMinute');
  if (wordsPerMinute !== null) out.wordsPerMinute = wordsPerMinute;
  return out;
}

/** Normalize and bound a finish_practice_interview payload; throws with the reason. */
export function validatePracticeFeedback(input) {
  if (!plain(input)) throw new Error('feedback must be an object.');
  if (!plain(input.overall)) throw new Error('overall must be an object with score and summary.');
  const overall = { score: score(input.overall.score, 'overall.score'), summary: bounded(input.overall.summary, LIMITS.long, 'overall.summary') };
  if (overall.score === null || !overall.summary) throw new Error('overall needs a score and a summary.');
  if (!Array.isArray(input.planned) || input.planned.length > LIMITS.planned) throw new Error(`planned must be an array of at most ${LIMITS.planned} entries.`);
  const planned = input.planned.map((item, index) => {
    if (!plain(item) || typeof item.asked !== 'boolean') throw new Error(`planned[${index}] needs question and asked.`);
    const question = bounded(item.question, LIMITS.short, `planned[${index}].question`);
    if (!question) throw new Error(`planned[${index}].question is required.`);
    // An unasked question has no performance to grade: a placeholder score
    // would read as a failing mark on the node.
    return { question, asked: item.asked, askedAs: bounded(item.askedAs, LIMITS.short, `planned[${index}].askedAs`), score: item.asked ? score(item.score, `planned[${index}].score`) : null,
      covered: bounded(item.covered, LIMITS.text, `planned[${index}].covered`), adapted: bounded(item.adapted, LIMITS.text, `planned[${index}].adapted`), improve: bounded(item.improve, LIMITS.text, `planned[${index}].improve`),
      extension: bounded(item.extension, LIMITS.text, `planned[${index}].extension`) };
  });
  const momentsIn = input.moments === undefined ? [] : input.moments;
  if (!Array.isArray(momentsIn) || momentsIn.length > LIMITS.moments) throw new Error(`moments must be an array of at most ${LIMITS.moments} entries.`);
  const moments = momentsIn.map((item, index) => {
    if (!plain(item) || !PRACTICE_MOMENT_KINDS.includes(item.kind)) throw new Error(`moments[${index}].kind must be one of ${PRACTICE_MOMENT_KINDS.join(', ')}.`);
    const prompt = bounded(item.prompt, LIMITS.short, `moments[${index}].prompt`);
    if (!prompt) throw new Error(`moments[${index}].prompt is required.`);
    return { kind: item.kind, prompt, score: score(item.score, `moments[${index}].score`), note: bounded(item.note, LIMITS.text, `moments[${index}].note`) };
  });
  const communicationIn = input.communication === undefined ? {} : input.communication;
  if (!plain(communicationIn)) throw new Error('communication must be an object.');
  const communication = Object.fromEntries(['pace', 'clarity', 'structure', 'confidence', 'filler'].map(key => [key, bounded(communicationIn[key], LIMITS.short, `communication.${key}`)]));
  if (!Array.isArray(input.priorities) || input.priorities.length > LIMITS.priorities) throw new Error(`priorities must be an array of at most ${LIMITS.priorities} strings.`);
  const priorities = input.priorities.map((item, index) => bounded(item, LIMITS.short, `priorities[${index}]`)).filter(Boolean);
  const transcriptIn = input.transcript === undefined ? [] : input.transcript;
  if (!Array.isArray(transcriptIn) || transcriptIn.length > LIMITS.transcript) throw new Error(`transcript must be an array of at most ${LIMITS.transcript} turns.`);
  const transcript = transcriptIn.map((item, index) => {
    if (!plain(item) || !['interviewer', 'candidate'].includes(item.role)) throw new Error(`transcript[${index}].role must be interviewer or candidate.`);
    const text = bounded(item.text, LIMITS.transcriptText, `transcript[${index}].text`);
    if (!text) throw new Error(`transcript[${index}].text is required.`);
    return { role: item.role, text };
  });
  const callId = callIdValue(input.callId);
  const delivery = deliveryNotes(input.delivery);
  return { overall, planned, moments, communication, priorities, transcript, ...(callId === null ? {} : { callId }), ...(delivery === null ? {} : { delivery }) };
}
