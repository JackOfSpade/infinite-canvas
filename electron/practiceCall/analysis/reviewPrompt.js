import { INTERVIEW_PRACTICE_FEEDBACK_SCHEMA } from '../../ipc/interviewQaPractice.js';

/** Kinds the reviewer may flag; `filler` marks a counted filler moment. */
export const REVIEW_MOMENT_KINDS = Object.freeze(['moment', 'filler']);

// Feedback without `session`: the call record already says which session this
// was, and the call service re-attaches it when the feedback is stored.
const reviewFeedbackSchema = Object.freeze({
  ...INTERVIEW_PRACTICE_FEEDBACK_SCHEMA,
  required: ['overall', 'planned', 'priorities'],
});

/** The single review response: practice feedback, chapters and flagged moments. */
export const REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['feedback', 'chapters', 'moments'],
  properties: {
    feedback: reviewFeedbackSchema,
    chapters: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object', additionalProperties: false, required: ['questionTurnIndex', 'title'],
        properties: {
          questionTurnIndex: { type: 'integer', minimum: 0, description: 'Index of the interviewer turn that asked the question.' },
          title: { type: 'string', maxLength: 120, description: 'Short chapter title for that question, in the candidate\'s own domain words.' },
        },
      },
    },
    moments: {
      type: 'array', maxItems: 40,
      items: {
        type: 'object', additionalProperties: false, required: ['turnIndex', 'label', 'kind'],
        properties: {
          turnIndex: { type: 'integer', minimum: 0, description: 'Index of the transcript turn where the moment happened.' },
          label: { type: 'string', maxLength: 200 },
          kind: { type: 'string', enum: REVIEW_MOMENT_KINDS },
        },
      },
    },
  },
});

const clock = ms => {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const line = value => (typeof value === 'string' ? value.trim() : '');

/** Prepared cards may be `question`/`headline`/`bullets`/`example` or a single `answer`. */
function planEntries(plan) {
  const cards = Array.isArray(plan) ? plan : plan?.cards ?? plan?.preparedCards ?? plan?.questions ?? [];
  return Array.isArray(cards) ? cards.filter(card => card && typeof card === 'object') : [];
}

function formatPlan(plan) {
  const entries = planEntries(plan);
  if (!entries.length) return '(no prepared answers were part of this call)';
  return entries.map((card, index) => {
    const parts = [`${index + 1}. ${line(card.question) || line(card.prompt) || '(question)'}`];
    if (line(card.scope)) parts.push(`   scope: ${line(card.scope)}`);
    if (line(card.headline)) parts.push(`   headline: ${line(card.headline)}`);
    if (Array.isArray(card.bullets) && card.bullets.length) parts.push(`   points: ${card.bullets.map(line).filter(Boolean).join(' | ')}`);
    if (line(card.example)) parts.push(`   example: ${line(card.example)}`);
    if (line(card.answer) || line(card.preparedAnswer)) parts.push(`   prepared answer: ${line(card.answer) || line(card.preparedAnswer)}`);
    return parts.join('\n');
  }).join('\n');
}

function wordsOf(entry) {
  const words = Array.isArray(entry) ? entry : entry?.words ?? [];
  return words.map(word => line(typeof word === 'string' ? word : word?.text)).filter(Boolean).join(' ');
}

function formatTranscript(transcript, wordsByTurn) {
  return transcript.map((turn, index) => {
    const who = turn.speaker === 'candidate' ? 'candidate' : 'interviewer';
    const head = `[${index}] ${who} ${clock(turn.startMs)}-${clock(turn.endMs)}${turn.channel && turn.channel !== 'audio' ? ` (${turn.channel})` : ''}: ${line(turn.text)}`;
    const extras = [];
    if (line(turn.heardText)) extras.push(`    heard as: ${line(turn.heardText)}`);
    const verbatim = wordsOf(wordsByTurn?.[index]);
    if (verbatim) extras.push(`    scribe verbatim: ${verbatim}`);
    if (turn.interrupted) extras.push('    (the interviewer was still speaking when this turn started)');
    return [head, ...extras].join('\n');
  }).join('\n');
}

function formatToneNotes(notes) {
  if (!Array.isArray(notes) || !notes.length) return '(no tone notes were taken during the call)';
  return notes.map(note => `- ${clock(note?.atMs)} ${line(note?.note)}`).join('\n');
}

function formatToneTimeline(samples) {
  if (!Array.isArray(samples) || !samples.length) return '(no tone samples)';
  return samples.map(sample => `${clock(sample?.atMs)} arousal ${sample?.arousal} dominance ${sample?.dominance} valence ${sample?.valence}`).join('\n');
}

function formatMetrics(metrics) {
  try {
    return JSON.stringify(metrics ?? {}, null, 2);
  } catch {
    return '(metrics were not serializable)';
  }
}

const RULES = [
  'You are reviewing one recorded mock interview the candidate just finished. This feedback is read, never spoken back during a call.',
  'Use only what the transcript, the metrics, the tone notes and the plan below support. Never invent a number that is not in the metrics; when you cite pace, pauses, talk time or words per minute, copy the measured value.',
  '- Fillers: count only non-lexical filler uses in the candidate\'s own words (the sounds people make while thinking). A word that carries meaning in that sentence is not a filler, and quoting a word from the plan is not a filler. Do not use any list of filler words; judge each use in context.',
  '- Aim for fewer fillers, not zero: fluent speech keeps some. Say what got in the way, not that any filler is a failure.',
  '- Chapters: one chapter per interviewer question turn, in the order they were asked. Use the turn index shown in brackets, and give each a short, specific title.',
  '- Moments: flag only moments worth replaying, with the turn index where they happened, a short label, and kind "filler" only for a counted filler moment.',
  '- Delivery: fill the delivery section from the measured numbers and the observed behaviour; it is a summary of pace, pauses, fillers, confidence, interruptions and any typed answers.',
].join('\n');

/** The one review prompt: timed transcript, plan, metrics, tone, Scribe words. */
export function buildReviewPrompt({ callRecord = {}, plan, brief, metrics, wordsByTurn = {}, transcriptionError = null, correction = null } = {}) {
  const transcript = Array.isArray(callRecord.transcript) ? callRecord.transcript : [];
  const role = [line(brief?.role?.title) || line(brief?.title), line(brief?.role?.company) || line(brief?.company)].filter(Boolean).join(' at ');
  const focus = line(callRecord.steering);
  const header = [
    `call id: ${line(callRecord.callId) || '(unknown)'}`,
    `interviewer persona: ${line(callRecord.persona) || '(unknown)'}`,
    focus ? `interview focus requested by the candidate: ${focus}` : '',
    focus ? 'judge the call against that requested focus: a stage, depth or topic the focus asked to skip or lighten is not a gap, so do not penalise the interviewer for leaving it out' : '',
    `started: ${line(callRecord.startedAt) || '(unknown)'}`,
    role ? `role: ${role}` : '',
    `length: ${clock(callRecord.durationMs)}`,
  ].filter(Boolean).join('\n');
  const sections = [
    RULES,
    '--- CALL ---', header,
    '--- PLAN (prepared answers the candidate could draw on) ---', formatPlan(plan),
    '--- TIMED TRANSCRIPT (turn indices are what chapters and moments must cite) ---', formatTranscript(transcript, wordsByTurn),
    '--- DETERMINISTIC METRICS (the only source of numbers) ---', formatMetrics(metrics),
    '--- CANDIDATE PROSODY BY TURN (measured per answer: pace, pauses with helper-timeline ms, pitch, loudness) ---', formatMetrics(callRecord.candidateProsodyByTurn ?? {}),
    '--- TONE NOTES (taken live during the call) ---', formatToneNotes(callRecord.toneNotes),
    '--- TONE TIMELINE (0-1 arousal, dominance, valence) ---', formatToneTimeline(callRecord.toneSamples),
  ];
  if (transcriptionError) sections.push(`--- TRANSCRIPTION NOTE ---\nThe verbatim Scribe pass failed (${line(transcriptionError) || 'unknown error'}), so no word-level transcript is available. Judge fillers only from the readable transcript, and do not claim a filler count you cannot support.`);
  if (correction) sections.push(`--- CORRECTION REQUIRED ---\nThe previous reply was rejected: ${line(correction) || 'it did not match the schema'}\nReturn the full JSON object again, corrected.`);
  return sections.join('\n\n');
}
