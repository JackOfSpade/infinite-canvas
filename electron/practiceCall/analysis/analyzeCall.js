import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { validatePracticeFeedback } from '../../ipc/interviewQaPractice.js';
import { buildReviewPrompt, REVIEW_MOMENT_KINDS, REVIEW_SCHEMA } from './reviewPrompt.js';
import { buildChapters } from './chapters.js';

// Opus at medium effort: the review is a judgement-and-writing task like
// qa-brief, and there is exactly one review call per practice, so it costs one
// prompt and response rather than a batch that would need a cheaper model.
const REVIEW_PROFILE = Object.freeze({ model: 'opus', effort: 'medium' });
const MAX_FEEDBACK_RETRIES = 1;
const list = value => (Array.isArray(value) ? value : []);
const clockMs = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const reason = error => (typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : String(error));

/** Lazy defaults: the parallel audio, Scribe and Claude modules need not exist for tests. */
async function resolveClients(deps) {
  const transcribe = deps.transcribe ?? await (async () => {
    const [scribe, keys] = await Promise.all([import('../eleven/scribe.js'), import('../eleven/elevenKey.js')]);
    const verbatim = scribe.transcribeVerbatim ?? scribe.default;
    const readKey = keys.readElevenLabsKey ?? keys.default;
    return async request => verbatim({ ...request, key: await readKey({ execFile: deps.execFile }) });
  })();
  const metrics = deps.metrics ?? await (async () => {
    const audio = await import('../audio/callMetrics.js');
    const compute = audio.callMetrics ?? audio.default;
    return request => compute(request);
  })();
  const callText = deps.callText ?? await (async () => {
    const { callLLMText } = await import('../../ipc/llm.js');
    return request => callLLMText(request.prompt, { task: 'practice-review', claudeStage: 'qa-practice-review', responseSchema: request.schema });
  })();
  return { transcribe, metrics, callText };
}

/** Scribe's verbatim words, bucketed into the candidate answer whose span holds them. */
export function wordsByAnswer(transcript, words) {
  const answers = transcript.map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn?.speaker === 'candidate' && clockMs(turn.startMs) !== null);
  const buckets = {};
  for (const word of list(words)) {
    const at = clockMs(word?.startMs) ?? clockMs(word?.start);
    if (at === null) continue;
    const hit = answers.find(({ turn }) => at >= turn.startMs && at <= (clockMs(turn.endMs) ?? Infinity));
    if (!hit) continue;
    (buckets[hit.index] ??= []).push(word);
  }
  return buckets;
}

/** Validate the review reply: feedback plus turn-index anchors inside the transcript. */
export function checkReview(raw, transcript) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the review reply was not a JSON object' };
  let feedback;
  try {
    feedback = validatePracticeFeedback(raw.feedback);
  } catch (error) {
    return { error: `feedback: ${reason(error)}` };
  }
  if (!Array.isArray(raw.chapters)) return { error: 'chapters must be an array' };
  const chapters = [];
  const seen = new Set();
  for (const entry of raw.chapters) {
    const index = entry?.questionTurnIndex;
    if (!Number.isInteger(index) || index < 0 || index >= transcript.length) return { error: `chapters: ${JSON.stringify(index)} is not a transcript turn index` };
    if (transcript[index]?.speaker !== 'interviewer') return { error: `chapters: turn ${index} is not an interviewer turn` };
    if (seen.has(index)) return { error: `chapters: turn ${index} is listed twice` };
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title) return { error: `chapters: turn ${index} needs a title` };
    seen.add(index);
    chapters.push({ questionTurnIndex: index, title });
  }
  if (!Array.isArray(raw.moments)) return { error: 'moments must be an array' };
  const moments = [];
  for (const entry of raw.moments) {
    const index = entry?.turnIndex;
    if (!Number.isInteger(index) || index < 0 || index >= transcript.length) return { error: `moments: ${JSON.stringify(index)} is not a transcript turn index` };
    if (!REVIEW_MOMENT_KINDS.includes(entry.kind)) return { error: `moments: kind must be one of ${REVIEW_MOMENT_KINDS.join(', ')}` };
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (!label) return { error: `moments: turn ${index} needs a label` };
    moments.push({ turnIndex: index, label, kind: entry.kind });
  }
  return { review: { feedback, chapters, moments } };
}

/** Filler totals: the review's counted total, with filler moments split per answer. */
export function fillerTotals({ feedback, moments = [], transcript = [], durationMs = 0 }) {
  const answers = transcript.map((turn, index) => ({ turn, index })).filter(({ turn }) => turn?.speaker === 'candidate');
  const starts = answers.map(({ turn }) => clockMs(turn.startMs) ?? 0);
  const byAnswer = answers.map(() => 0);
  for (const moment of list(moments)) {
    if (moment?.kind !== 'filler') continue;
    const at = clockMs(transcript[moment.turnIndex]?.startMs) ?? 0;
    let slot = -1;
    starts.forEach((start, position) => { if (start <= at) slot = position; });
    if (slot >= 0) byAnswer[slot] += 1;
  }
  const reported = feedback?.delivery?.fillerCount;
  const total = Number.isInteger(reported) && reported >= 0 ? reported : byAnswer.reduce((sum, count) => sum + count, 0);
  const perMinute = durationMs > 0 ? Math.round((total / (durationMs / 60_000)) * 10) / 10 : 0;
  return { total, perMinute, byAnswer };
}

/** Write analysis.json atomically (temp file, 0600, then rename). */
async function writeAnalysis(callDir, analysis, io = {}) {
  const mkdir = io.mkdir ?? nodeFs.mkdir;
  const writeFile = io.writeFile ?? nodeFs.writeFile;
  const rename = io.rename ?? nodeFs.rename;
  const unlink = io.unlink ?? nodeFs.unlink;
  const target = path.join(callDir, 'analysis.json');
  const temp = path.join(callDir, `.analysis.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await mkdir(callDir, { recursive: true });
  try {
    await writeFile(temp, `${JSON.stringify(analysis, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return target;
}

export async function analyzeCall({ callDir, callRecord = {}, plan, brief, deps = {} } = {}) {
  if (typeof callDir !== 'string' || !callDir) throw new Error('analyzeCall needs the call directory.');
  if (!callRecord || typeof callRecord !== 'object') throw new Error('analyzeCall needs the call record.');
  const transcript = list(callRecord.transcript);
  const durationMs = clockMs(callRecord.durationMs) ?? transcript.reduce((max, turn) => Math.max(max, clockMs(turn?.endMs) ?? 0), 0);
  const createdAt = (deps.now ?? (() => new Date().toISOString()))();
  const clients = await resolveClients(deps);

  let words = [];
  let transcriptionError = null;
  try {
    const scribed = await clients.transcribe({ path: path.join(callDir, 'candidate.wav') });
    words = list(scribed?.words);
  } catch (error) {
    // Scribe failing only costs the word-level view; the call still gets metrics and a review.
    transcriptionError = reason(error);
  }
  let metrics = null;
  let metricsError = null;
  try {
    metrics = await clients.metrics({
      transcript,
      candidateProsodyByTurn: callRecord.candidateProsodyByTurn ?? {},
      baselineSnapshot: callRecord.baseline ?? null,
    });
  } catch (error) {
    metricsError = reason(error);
  }
  const wordsByTurn = wordsByAnswer(transcript, words);
  // analysis.json key order follows the build doc.
  const compose = ({ status, chapters, fillers, error: failure }) => ({
    callId: callRecord.callId, status, createdAt, metrics, chapters,
    toneTimeline: list(callRecord.toneSamples), fillers,
    ...(failure ? { error: failure } : {}),
    ...(metricsError ? { metricsError } : {}),
  });

  let checked = null;
  let error = null;
  for (let attempt = 0; attempt <= MAX_FEEDBACK_RETRIES && !checked; attempt += 1) {
    const request = { prompt: buildReviewPrompt({ callRecord, plan, brief, metrics, wordsByTurn, transcriptionError, correction: error }),
      schema: REVIEW_SCHEMA, profile: REVIEW_PROFILE };
    let raw;
    try {
      raw = await clients.callText(request);
    } catch (thrown) {
      error = `the review call failed: ${reason(thrown)}`;
      continue;
    }
    const checkedAttempt = checkReview(raw, transcript);
    if (checkedAttempt.review) checked = checkedAttempt.review;
    else error = checkedAttempt.error;
  }
  if (!checked) {
    const analysis = compose({ status: 'failed', chapters: [], fillers: { total: 0, perMinute: 0, byAnswer: [] }, error });
    await writeAnalysis(callDir, analysis, deps);
    return { analysis, feedback: null };
  }

  const chapters = buildChapters({ transcript, reviewChapters: checked.chapters, moments: checked.moments, metrics, toneNotes: list(callRecord.toneNotes), candidateProsodyByTurn: callRecord.candidateProsodyByTurn ?? {}, durationMs });
  const analysis = compose({ status: 'ready', chapters, fillers: fillerTotals({ feedback: checked.feedback, moments: checked.moments, transcript, durationMs }) });
  await writeAnalysis(callDir, analysis, deps);
  return { analysis, feedback: { ...checked.feedback, callId: callRecord.callId } };
}
