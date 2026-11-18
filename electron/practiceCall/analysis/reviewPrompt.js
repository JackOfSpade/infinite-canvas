import { INTERVIEW_PRACTICE_FEEDBACK_SCHEMA } from '../../ipc/interviewQaPractice.js';
import { prosodyByEntry } from '../audio/callMetrics.js';

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

/** The persona is stored as an object (name, role, team, temperament); an older record may hold a string. */
function personaText(persona) {
  if (typeof persona === 'string') return line(persona);
  if (!persona || typeof persona !== 'object') return '';
  const head = [line(persona.name), line(persona.role), line(persona.team)].filter(Boolean).join(', ');
  const temperament = line(persona.temperament);
  return temperament ? `${head}${head ? ' ' : ''}(${temperament})` : head;
}

/** The start time is stored as epoch milliseconds; an older record may hold an ISO string. */
function startedText(value) {
  if (typeof value === 'string') return line(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** How the candidate answered: spoken answers, typed answers, or both. Acknowledgements are neither. */
export function candidateAnswerKinds(transcript) {
  const turns = Array.isArray(transcript) ? transcript : [];
  const own = turns.filter(turn => turn?.speaker === 'candidate' && !turn.acknowledgement);
  const spoken = own.filter(turn => turn.channel !== 'chat').length;
  const typed = own.length - spoken;
  return { spoken, typed, typedOnly: spoken === 0 && typed > 0 };
}

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

const LEAD_ID = 'A';

/**
 * Every interviewer of a panel call, lead first. The record keeps the lead in `persona` and may
 * or may not repeat them in `panel`; a solo call (empty panel) gives an empty list.
 */
function panelInterviewers(callRecord) {
  const panel = Array.isArray(callRecord?.panel) ? callRecord.panel.filter(member => member && typeof member === 'object') : [];
  if (!panel.length) return [];
  const persona = callRecord.persona && typeof callRecord.persona === 'object' ? callRecord.persona : {};
  const lead = panel.find(member => member.id === LEAD_ID) ?? { id: LEAD_ID, name: persona.name, role: persona.role };
  return [lead, ...panel.filter(member => member !== lead)];
}

function interviewerText(member) {
  const parts = [line(member.name) || `interviewer ${line(member.id)}`.trim()];
  if (line(member.role)) parts.push(line(member.role));
  const focus = line(member.focus);
  const late = member.joins === 'late';
  const when = typeof member.joinedAtMs === 'number' && Number.isFinite(member.joinedAtMs) ? ` at ${clock(member.joinedAtMs)}` : '';
  const tail = [
    focus ? `focus: ${focus}` : '',
    late ? (when ? `joined late${when}` : 'joined late, but never joined the call') : '',
  ].filter(Boolean);
  return `${parts.join(', ')}${tail.length ? ` (${tail.join('; ')})` : ''}`;
}

function formatTranscript(transcript, wordsByTurn, interviewers = []) {
  const names = new Map(interviewers.map(member => [member.id, line(member.name)]).filter(([, name]) => name));
  return transcript.map((turn, index) => {
    const named = turn.speaker !== 'candidate' ? names.get(turn.speakerId) : '';
    const who = turn.speaker === 'candidate' ? 'candidate' : (named || 'interviewer');
    const segments = turn.speaker !== 'candidate' && interviewers.length && Array.isArray(turn.segments)
      ? turn.segments.filter(segment => line(segment?.text)) : [];
    // A hand-over inside one turn: each segment gets its own line so the reviewer sees who said what.
    const overlap = turn.overlay && turn.speaker !== 'candidate' ? ' (overlapping remark, said over the speaker)' : '';
    const head = `[${index}] ${who}${overlap} ${clock(turn.startMs)}-${clock(turn.endMs)}${turn.channel && turn.channel !== 'audio' ? ` (${turn.channel})` : ''}:${segments.length ? '' : ` ${line(turn.text)}`}`;
    const extras = segments.map(segment => `    ${names.get(segment.speakerId) || 'interviewer'}: ${line(segment.text)}`);
    if (line(turn.heardText)) extras.push(`    heard as: ${line(turn.heardText)}`);
    const verbatim = wordsOf(wordsByTurn?.[index]);
    if (verbatim) extras.push(`    scribe verbatim: ${verbatim}`);
    if (turn.interrupted) extras.push('    (the interviewer was still speaking when this turn started)');
    return [head, ...extras].join('\n');
  }).join('\n');
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
  'Use only what the transcript, the metrics and the plan below support. Never invent a number that is not in the metrics; when you cite pace, pauses, talk time or words per minute, copy the measured value.',
  '- Fillers: count only non-lexical filler uses in the candidate\'s own words (the sounds people make while thinking). A word that carries meaning in that sentence is not a filler, and quoting a word from the plan is not a filler. Do not use any list of filler words; judge each use in context.',
  '- Write every duration the way a person would say it, in seconds or in minutes and seconds ("about a minute and a half", "01:32"). Never print a raw millisecond count, even though the metrics are in milliseconds.',
  '- Aim for fewer fillers, not zero: fluent speech keeps some. Say what got in the way, not that any filler is a failure.',
  '- Chapters: one chapter per interviewer question turn, in the order they were asked. Use the turn index shown in brackets, and give each a short, specific title.',
  '- Moments: flag only moments worth replaying, with the turn index where they happened, a short label, and kind "filler" only for a counted filler moment.',
  '- Delivery: fill the delivery section from the measured numbers and the observed behaviour; it is a summary of pace, pauses, fillers, confidence, interruptions and any typed answers.',
  '- Typed turns: a transcript turn marked (chat) was typed, not spoken. A typed line from the candidate is one of their answers and is judged for content, structure and relevance like any spoken answer. Never make a claim about pace, pauses, fillers, confidence or tone for a typed turn: typing has no voice to measure.',
].join('\n');

const PANEL_RULE = '- Panel: more than one interviewer was on this call. Say how the candidate handled that (addressing the right person, coping with a hand-over between interviewers or with a colleague who joined late), but only when the transcript shows it. Do not comment on it otherwise, and do not fault the candidate for how the interviewers dealt with each other.';

const TYPED_ONLY_NOTE = [
  'The candidate answered only by typing in the chat; every candidate turn below is typed text, and no spoken answer was recorded. This is how the call went, not a technical failure.',
  'Judge the typed answers as the candidate\'s answers, for content, structure and relevance.',
  'Delivery could not be measured because the call was typed. In the delivery section, say that plainly in the summary, and in pace, pauses, fillers and confidence say it could not be measured; leave out fillerCount and wordsPerMinute. Make no claim about pace, pauses, fillers, confidence or tone anywhere in the review.',
].join('\n');

 const REVIEW_SCREEN_CAP = 6000;
 const REVIEW_PAD_CAP = 12000;

const cut = (text, cap) => (text.length > cap ? `${text.slice(0, cap)}\n(cut: the first ${cap} characters of ${text.length} are shown)` : text);

// A fence longer than any backtick run inside keeps the data from closing its own block.
function fenced(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** Where a time falls against the transcript: the last turn that had started by then. */
function turnAt(transcript, atMs) {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return 'at an unknown time';
  let index = -1;
  transcript.forEach((turn, i) => { if (typeof turn?.startMs === 'number' && turn.startMs <= atMs) index = i; });
  return index < 0 ? 'before the first transcript turn' : `during or after transcript turn [${index}]`;
}

function formatScreens(screens, transcript) {
  return screens.map((screen, index) => {
    const ended = typeof screen.endMs === 'number' && Number.isFinite(screen.endMs) ? `, until ${clock(screen.endMs)}` : ', until the end of the call';
    const head = `screen ${index + 1}: "${line(screen.title) || '(untitled)'}" shown at ${clock(screen.atMs)} (${turnAt(transcript, screen.atMs)})${ended}`;
    return `${head}\n${fenced(cut(String(screen.content ?? '').trim(), REVIEW_SCREEN_CAP))}`;
  }).join('\n\n');
}

/** The one question the candidate had not prepared: { text, askedBy } on the call record, or the number-0 plan entry. */
function unpreparedText(callRecord) {
  const direct = line(callRecord?.unpreparedQuestion?.text);
  if (direct) return direct;
  const entries = callRecord?.setup?.plan?.questions;
  const zero = Array.isArray(entries) ? entries.find(entry => entry && entry.number === 0) : null;
  return line(zero?.text);
}

const UNPREPARED_NOTE = (text) => [
  `One question on this call was not one the candidate had prepared: "${text}"`,
  'There is no prepared answer for it. Judge the candidate\'s answer to it on its own, as a test of adaptability: structure, relevance and composure. Never fault it for departing from prepared material. The other questions are the ones with prepared answers above.',
].join('\n');

const SCREEN_PAD_RULE = '- Shared screen and coding pad: when the data below shows screens the interviewer shared or code the candidate wrote, judge the written code for correctness, edge cases and how the candidate talked through it, and say whether they addressed each part shown. Never claim anything about code that is not in the pad text below; if the pad is empty or missing, say no code was written.';

/** The one review prompt: timed transcript, plan, metrics, tone, Scribe words. */
export function buildReviewPrompt({ callRecord = {}, plan, brief, metrics, wordsByTurn = {}, transcriptionError = null, correction = null } = {}) {
  const transcript = Array.isArray(callRecord.transcript) ? callRecord.transcript : [];
  const role = [line(brief?.role?.title) || line(brief?.title), line(brief?.role?.company) || line(brief?.company)].filter(Boolean).join(' at ');
  const focus = line(callRecord.steering);
  const reason = line(callRecord.reason);
  // The candidate hung up or closed the window while the interviewer was still in the call.
  const candidateEnded = reason === 'candidate' || reason === 'window-closed';
  // Anything else but the interviewer's own wrap-up (audio helper, session or other failure) cut the call short.
  const technicalEnd = Boolean(reason) && !candidateEnded && reason !== 'interviewer';
  const { typedOnly } = candidateAnswerKinds(transcript);
  const interviewers = panelInterviewers(callRecord);
  const header = [
    `call id: ${line(callRecord.callId) || '(unknown)'}`,
    `interviewer persona: ${personaText(callRecord.persona) || '(unknown)'}`,
    interviewers.length ? `interviewers on this call (a panel): ${interviewers.map(interviewerText).join('; ')}` : '',
    focus ? `interview focus requested by the candidate: ${focus}` : '',
    focus ? 'judge the call against that requested focus: a stage, depth or topic the focus asked to skip or lighten is not a gap, so do not penalise the interviewer for leaving it out' : '',
    `started: ${startedText(callRecord.startedAt) || '(unknown)'}`,
    role ? `role: ${role}` : '',
    `length: ${clock(callRecord.durationMs)}`,
    candidateEnded ? 'how the call ended: the candidate ended the call early, before the interviewer had wrapped up or said goodbye' : '',
    technicalEnd ? `how the call ended: a technical failure cut the call short (${reason}); the candidate did not end it and must not be faulted for it` : '',
    candidateEnded || technicalEnd ? `review only the part of the call that took place. Planned questions that were never reached are not asked: do not score them or count them against the candidate, and do not treat the missing wrap-up or the closing questions of the candidate as a gap. Say once in the overall summary that the call ended early${technicalEnd ? ' because of a technical problem' : ''} and the review covers the call up to that point` : '',
    callRecord.reason === 'interviewer' ? 'how the call ended: the interviewer wrapped up and ended the call' : '',
  ].filter(Boolean).join('\n');
  const measuredProsody = prosodyByEntry(transcript, callRecord.candidateProsody);
  const screens = Array.isArray(callRecord.screens)
    ? callRecord.screens.filter(screen => screen && typeof screen === 'object' && line(screen.content)) : [];
  const snapshots = Array.isArray(callRecord.pad?.snapshots) ? callRecord.pad.snapshots : [];
  const padText = String(snapshots.at(-1)?.text ?? '').trim();
  const hasPad = Boolean(padText);
  const unprepared = unpreparedText(callRecord);
  const sections = [
    [RULES, interviewers.length ? PANEL_RULE : '', screens.length || hasPad ? SCREEN_PAD_RULE : ''].filter(Boolean).join('\n'),
    '--- CALL ---', header,
    ...(typedOnly ? ['--- HOW THE CANDIDATE ANSWERED ---', TYPED_ONLY_NOTE] : []),
    '--- PLAN (prepared answers the candidate could draw on; the interviewers did not see them) ---', formatPlan(plan),
    ...(unprepared ? ['--- THE UNPREPARED QUESTION ---', UNPREPARED_NOTE(unprepared)] : []),
    '--- TIMED TRANSCRIPT (turn indices are what chapters and moments must cite) ---', formatTranscript(transcript, wordsByTurn, interviewers),
    '--- DETERMINISTIC METRICS (the only source of numbers) ---', formatMetrics(metrics),
    ...(screens.length ? ['--- SHARED SCREENS (what the interviewer showed, in order; the interviewer did not read this aloud) ---', formatScreens(screens, transcript)] : []),
    ...(hasPad ? [`--- CANDIDATE CODING PAD (final text${line(callRecord.pad?.lang) ? `, language: ${line(callRecord.pad.lang)}` : ''}) ---`, fenced(cut(padText, REVIEW_PAD_CAP))] : []),
    ...(typedOnly ? [] : [
      '--- CANDIDATE PROSODY BY TURN (measured per spoken answer, keyed by transcript turn index: pace, pauses with helper-timeline ms, pitch, loudness; typed turns have none) ---', formatMetrics(measuredProsody),
      '--- TONE TIMELINE (0-1 arousal, dominance, valence; spoken answers only) ---', formatToneTimeline(callRecord.toneSamples),
    ]),
  ];
  if (transcriptionError) sections.push(`--- TRANSCRIPTION NOTE ---\nThe verbatim Scribe pass failed (${line(transcriptionError) || 'unknown error'}), so no word-level transcript is available. Judge fillers only from the readable transcript, and do not claim a filler count you cannot support.`);
  if (correction) sections.push(`--- CORRECTION REQUIRED ---\nThe previous reply was rejected: ${line(correction) || 'it did not match the schema'}\nReturn the full JSON object again, corrected.`);
  return sections.join('\n\n');
}
