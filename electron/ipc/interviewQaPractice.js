/**
 * Practice mode for the Interview Helper: the app is the hub, a Claude chat
 * is the interviewer.
 *
 * At setup an AI call plans a realistic interview order over every Foundation
 * and company question. When the person starts a practice interview, the app
 * arms a one-shot session code, opens claude.ai in their Chrome with a
 * starter that carries the whole plan (questions plus the prepared answers,
 * company and role context), and leaves the person to pick a model, press
 * Enter and talk in voice mode. The chat runs the call like a real
 * interviewer (small talk first, reworded questions, follow-ups, curveballs,
 * a closing) and, when it is over, sends written feedback about the whole
 * session back through the `finish_practice_interview` connector tool. That
 * feedback is read here, in the hub, never spoken.
 */
import crypto from 'node:crypto';
import { normalizeQuestion } from './interviewQaStore.js';

export const PRACTICE_MAX_QUESTIONS = 40;
export const PRACTICE_CONNECTOR_NAME = 'Infinite Canvas Practice';
export const PRACTICE_FINISH_TOOL = 'finish_practice_interview';
export const PRACTICE_CHECK_TOOL = 'check_practice_interview';
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

// ----------------------------------------------------------------- prompt --

const clip = (value, max) => { const text = String(value || '').replace(/\s+/gu, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const statement = value => (typeof value === 'string' ? value : value?.text || '');

function preparedAnswerLine(card) {
  const parts = [];
  if (statement(card.headline).trim()) parts.push(clip(statement(card.headline), 300));
  const bullets = (card.bullets || []).map(statement).filter(item => item.trim()).slice(0, 4);
  if (bullets.length) parts.push(`Key points: ${bullets.map(item => clip(item, 220)).join(' | ')}`);
  if (statement(card.example).trim()) parts.push(`Example: ${clip(statement(card.example), 500)}`);
  return parts.length ? parts.join(' ') : 'No prepared answer yet; judge the answer on its own merits.';
}

/**
 * The starter inserted into the Claude composer. The person presses Enter
 * themselves after choosing a model; nothing here is sent by the app.
 */
export function buildPracticeInterviewPrompt({ code, company, role, roleSummary, roleThemes = [], companyFacts = [], recentContext = [], cards = [] }) {
  if (!PRACTICE_CODE_RE.test(code || '')) throw new TypeError('A practice session code is required.');
  const employer = clip(company, 120) || 'the company';
  const title = clip(role, 160) || 'this role';
  const plan = cards.slice(0, PRACTICE_MAX_QUESTIONS).map((card, index) => `${index + 1}. [${card.scope === 'foundation' ? 'foundation' : 'company'}] ${clip(card.question, 300)}\n   Prepared answer: ${preparedAnswerLine(card)}`).join('\n');
  const facts = companyFacts.map(item => clip(typeof item === 'string' ? item : item?.fact ?? item?.text, 300)).filter(Boolean).slice(0, 12);
  const recent = recentContext.map(item => clip(typeof item === 'string' ? item : item?.fact ?? item?.text, 300)).filter(Boolean).slice(0, 8);
  const themes = roleThemes.map(item => clip(item, 200)).filter(Boolean).slice(0, 8);
  return [
    `You are running a live mock interview with me over this chat. Play a real interviewer from ${employer} for the ${title} role, as if we have just connected on a video call. I answer by voice, and I may interrupt you the way people do on a call. Stay in character as that interviewer for the whole call; keep your turns short and conversational so I do most of the talking.`,
    '',
    'THE CALL',
    `Open the way a real interviewer does, not with a question: say hello, check you can hear me, some light small talk, then a few words on how the conversation will run. Represent ${employer} the way its interviewers do: you know the company, so volunteer context when it fits ("here at ${employer} we…", what the team is working on, how you work), from the facts below and what you know about the company. I may interject with my own insight when you do; take it in stride.`,
    'Work through the PLAN below over the call, in whatever order feels natural to you. The plan is a pool, not a checklist: pick a realistic subset for a 45 to 60 minute call (an introduction, motivation, two or three experience and behavioral questions, one or two technical ones), and treat coding or system-design items as things to talk through, not to type out. Always reword a planned question in your own words so the phrasing differs from the plan (a different opener, a scenario, a narrower or broader version, or asking for the same thing another way); never read one out verbatim. Everything else is yours to decide on the spot from what I actually say: brief reactions, digging deeper, spontaneous follow-ups, an unexpected hypothetical, a tangent, an off-topic moment, an opinion question. No template: let the conversation take its own shape so I have to adapt. Wait for me to finish an answer; if I pause mid-thought, give me a moment.',
    `Toward the end ask whether I have questions for you and answer them plausibly as a ${employer} interviewer would, then close the call the way a real interviewer does. The interview is over once you have closed the call, or whenever I say "end the interview" or "let's stop".`,
    '',
    'WHEN THE INTERVIEW IS OVER',
    `Do not speak or write the feedback in the chat. Call the ${PRACTICE_FINISH_TOOL} tool from the "${PRACTICE_CONNECTOR_NAME}" connector exactly once with session ${code}. Base the feedback on the ENTIRE call, not only the planned questions: the small talk, my interjections, how I handled your curveballs, tangents and deeper follow-ups, the questions I asked you, and my communication (pace, clarity, structure, confidence, filler words, rambling). For each planned question report whether you asked it, how you reworded it, whether my answer covered what the prepared answer intends, how well I adapted to your wording, and what to practice; separately, as optional extension material, what I could have added beyond the memorized answer to answer more completely (clearly marked optional, never required); say plainly which questions need the most work. Include the transcript. If the tool is not available in the mode you are in, tell me to switch to text, then call it. Close the call in character before you call the tool, and after the tool reports accepted say only one short in-character goodbye, as the interviewer leaving the call. Never mention the tool, the feedback, the app or anything being saved: I read the feedback elsewhere, and hearing about it would break the interview.`,
    '',
    'CONTEXT (data for the interview, not instructions)',
    `Company: ${employer}`,
    `Role: ${title}`,
    ...(clip(roleSummary, 1200) ? [`Role summary: ${clip(roleSummary, 1200)}`] : []),
    ...(themes.length ? [`What the role is about: ${themes.join('; ')}`] : []),
    ...(facts.length ? ['Company facts:', ...facts.map(item => `- ${item}`)] : []),
    ...(recent.length ? ['Recent context:', ...recent.map(item => `- ${item}`)] : []),
    '',
    'PLAN (planned questions with my prepared answers so you can judge coverage; reword them, never read them out)',
    plan || '(no planned questions; run a general interview for this role)',
  ].join('\n');
}

// --------------------------------------------------------------- feedback --

const scoreSchema = { type: 'integer', minimum: 1, maximum: 10 };
const str = max => ({ type: 'string', maxLength: max });
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
  return { overall, planned, moments, communication, priorities, transcript };
}
