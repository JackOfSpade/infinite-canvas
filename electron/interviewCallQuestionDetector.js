/** Silence-delimited, revision-aware question detection. No model or transport. */
import { isDependentInterviewFollowUp, isLikelyInterviewQuestion } from '../src/utils/interviewHelper.js';
import { matchInterviewAnswerCard } from '../src/utils/interviewAnswerMatching.js';

const MAX_QUESTION_CHARS = 2000;
const MAX_SEGMENTS = 128;
const MAX_RETIRED_SEGMENTS = 512;
const FILLER_PHRASE = "(?:okay|ok|all right|alright|right|so|and|also|well|thanks(?: for that)?|thank you(?: for that)?|great|perfect|cool|nice|got it|i see|(?:that )?makes sense|that['’]s (?:helpful|great)|next one|um|uh|hmm|mm[- ]?hmm?|mhm|uh[- ]?huh)";
// The offline gate may recognize neutral delivery language, but it must keep
// detached factual scope (an employer, quantity or requirement) in the turn.
const DELIVERY_PHRASE = `(?:thanks? for (?:sharing|explaining|clarifying)(?: that)?|thank you for (?:sharing|explaining|clarifying)(?: that)?|that (?:was|sounds?) (?:great|helpful|interesting|useful)|next|${FILLER_PHRASE})`;
const DELIVERY_PREFIX = new RegExp(`^(?:${DELIVERY_PHRASE}\\b[,;:.!?]*\\s+)+`, 'iu');
const QUESTION_JOIN = /(?:[;,:]\s*|\s+and\s+)(?=(?:and\s+)?(?:how|what|why|when|where|which|who|can you|could you|would you|tell me|describe|walk me)\b)/iu;
const SAFE_FILLER = new RegExp(`^(?:${FILLER_PHRASE}\\b[\\s,;:.!?]*)+$`, 'iu');
const SAFE_DELIVERY = new RegExp(`^(?:${DELIVERY_PHRASE}\\b[\\s,;:.!?]*)+$`, 'iu');
const INCOMPLETE_SCAFFOLD = /^(?:(?:can|could|would) you (?:please )?)?(?:(?:please )?(?:briefly )?)?(?:tell me about(?: a time(?: when)?)?|walk me through|give me an example(?: of)?|describe|explain)(?: your| the| a| an)?$/iu;
const TRAILING_FUNCTION_WORD = /\b(?:and|or|about|through|with|for|to|of|your|the|an|a)$/iu;

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function cleanTranscriptText(value) {
  // Detached sentence punctuation is an ASR artefact, not a spoken segment.
  // Leave attached punctuation, quotes, decimals and internal punctuation alone.
  return cleanText(value).replace(/^(?:[.,;:!?…]+(?:\s+|$))+/u, '')
    .replace(/[\s,;:]+$/u, '')
    .replace(/([.!?…]["'”’)\]]*)(?:\s+[.,;:!?…]+)+$/u, '$1')
    .replace(/\s+([.!?…]+)$/u, '$1');
}

const revisionText = text => text.toLowerCase().replace(/[\p{P}\s]+/gu, ' ').trim();

function recoverTrailingWords(finalText, volatileText) {
  const words = text => [...text.matchAll(/[^\p{P}\s]+/gu)]
    .map(match => ({ text: match[0].toLowerCase(), index: match.index }));
  const committed = words(finalText);
  const heard = words(volatileText);
  // Inflated volatile ranges alone must not slow a final that already contains
  // all heard words (possibly with insertions/corrected punctuation).
  let covered = 0;
  for (const word of committed) {
    if (word.text === heard[covered]?.text) covered += 1;
  }
  if (covered === heard.length) return null;
  const withEnding = text => /[.!?…]["'”’)\]]*$/u.test(text)
    ? text : text + (finalText.match(/[.!?…]+$/u)?.[0] ?? '');
  if (committed.length && committed.every((word, index) => word.text === heard[index]?.text)) {
    return withEnding(volatileText);
  }
  // A unique matching suffix anchors the final's end in the old hypothesis.
  // Require at least two words rather than guessing from a common lone word.
  for (let size = Math.min(committed.length, heard.length); size >= 2; size -= 1) {
    const ends = [];
    for (let end = size; end <= heard.length; end += 1) {
      if (committed.slice(-size).every((word, index) => word.text === heard[end - size + index].text)) ends.push(end);
    }
    if (ends.length > 1) break;
    if (ends.length === 1) {
      if (ends[0] === heard.length) return null;
      return withEnding(`${finalText.replace(/[.!?…]+$/u, '')} ${volatileText.slice(heard[ends[0]].index)}`);
    }
  }
  // Without word timings or a safe alignment, retain the more complete
  // hypothesis, not a concatenation of two competing whole revisions.
  return heard.length > committed.length ? withEnding(volatileText) : finalText;
}

/** Speculation deliberately has no question-shaped lexical gate. */
export function isInterviewPartialEligible(value) {
  const text = cleanText(value);
  return text.length <= MAX_QUESTION_CHARS && text.split(/\s+/u).length >= 3 && !SAFE_FILLER.test(text);
}

function needsContinuationPause(value) {
  // This changes only endpoint timing. It never rejects text or decides what
  // the turn means; even an unfinished fragment eventually reaches the AI.
  const tail = value.split(/(?<=[.!?])\s+/u).at(-1).replace(DELIVERY_PREFIX, '');
  if (/\?\s*$/u.test(tail)) return false;
  const plain = tail.replace(/[.!]+$/gu, '').trim();
  return INCOMPLETE_SCAFFOLD.test(plain) || TRAILING_FUNCTION_WORD.test(plain);
}

function questionPart(value) {
  const text = value.trim().replace(DELIVERY_PREFIX, '').replace(/^and\s+/iu, '');
  if (isDependentInterviewFollowUp(text)) return text;
  const plain = text.replace(/[.!?]+$/gu, '').trim();
  const words = plain.split(/\s+/u);
  // A few ordinary complete questions are shorter than the general fragment
  // gate. Keep the exceptions explicit rather than accepting every noun pair.
  if (/^(?:why (?:us|you|this role|this company)|what motivates you|what['’]s your (?:background|experience|availability|notice|salary))$/iu.test(plain)) return text;
  if (words.length < 4 || !isLikelyInterviewQuestion(plain)) return null;
  // These are ordinary narrative clauses, even if ASR supplied a question mark.
  if (/^(?:what|how|why|when|where|which|who)\s+(?:I|we|you|they|he|she|this|that|it|my|our|their)\b/iu.test(plain)) return null;
  if (/^(?:how|why|when|where)\s+to\b/iu.test(plain)) return null;
  // Do not let incomplete ASR scaffolding advance a locked answer.
  if (INCOMPLETE_SCAFFOLD.test(plain)) return null;
  if (!/\?\s*$/u.test(text) && TRAILING_FUNCTION_WORD.test(plain)) return null;
  return text;
}

/** Keep all question parts from one output turn; never silently choose its tail. */
export function classifyInterviewCallQuestion(value) {
  const text = cleanText(value);
  if (!text || text.length > MAX_QUESTION_CHARS) return null;
  const sentences = text.split(/(?<=[.!?])\s+/u);
  const clauses = sentences.flatMap(sentence => sentence.split(/[;:]\s*/u))
    .flatMap(clause => clause.split(QUESTION_JOIN)).map(clause => clause.trim()).filter(Boolean);
  const detected = clauses.map(questionPart);
  const parts = detected.filter(Boolean);
  if (!parts.length) return null;
  return {
    // Preserve meaningful context rather than reconstructing a shorter prompt
    // from only the recognized clauses. Strip only harmless delivery words.
    question: text.replace(DELIVERY_PREFIX, ''),
    parts,
    dependent: parts.length === 1 && isDependentInterviewFollowUp(parts[0]),
    multipart: parts.length > 1,
    contextUncertain: clauses.some((clause, index) => !detected[index] && !SAFE_DELIVERY.test(clause)),
  };
}

/**
 * A single clear unmatched question can use the existing honest cue fallback.
 * Several independent questions may auto-advance only when every part selects
 * the same prepared card. Follow-ups use the existing finite story grammar.
 */
export function selectInterviewCallQuestion(endpoint, answerBank, { semantic = false } = {}) {
  if (endpoint?.reason === 'too-long') return { accepted: false, reason: 'too-long' };
  if (semantic) {
    const question = cleanText(endpoint?.text);
    if (question.length > MAX_QUESTION_CHARS) return { accepted: false, reason: 'too-long' };
    if (!question || SAFE_FILLER.test(question)) return { accepted: false, reason: 'not-question' };
    // The live matcher classifies the complete turn, including short prompts,
    // delivery words, statements and multipart context. Local syntax cannot
    // tell a new question from an acknowledgement or a contextual follow-up.
    return { accepted: true, question, dependent: false, reason: 'semantic-turn' };
  }
  const candidate = classifyInterviewCallQuestion(endpoint?.text);
  if (!candidate) return { accepted: false, reason: 'not-question' };
  // A detached employer, number or other scope clause could change which
  // story answers the question. The existing matcher deliberately selects
  // question-shaped text, so do not let it silently discard that context.
  if (candidate.contextUncertain) return { accepted: false, reason: 'context-uncertain' };
  const { question, parts, dependent } = candidate;
  if (parts.length === 1) return { accepted: true, question: dependent ? parts[0] : question, dependent, reason: dependent ? 'follow-up' : 'question' };
  const independent = parts.filter(part => !isDependentInterviewFollowUp(part));
  if (!independent.length) return { accepted: false, reason: 'multipart-unmatched' };
  const matches = independent.map(part => matchInterviewAnswerCard(part, answerBank));
  if (matches.some(card => !card)) return { accepted: false, reason: 'multipart-unmatched' };
  if (new Set(matches.map(card => card.id)).size !== 1) return { accepted: false, reason: 'multipart-conflict' };
  // A dependent result/lesson prompt cannot borrow a card which never prepared
  // that component. The existing matcher already applies that evidence gate.
  if (independent.length !== parts.length
    && matchInterviewAnswerCard(question, answerBank)?.id !== matches[0].id) {
    return { accepted: false, reason: 'multipart-unmatched' };
  }
  return { accepted: true, question, dependent: false, reason: 'same-card' };
}

/**
 * SpeechTranscriber has ordered final commits and ONE replaceable volatile
 * tail, not independent volatile segments (WWDC25 session 277, 13:31).
 * Final ASR results never endpoint on their own: only output silence does.
 * `now` is a main-process monotonic receipt clock, never native/client input.
 */
export function createInterviewCallQuestionDetector({ silenceMs = 800, stabilityMs = 250, finalWaitMs = 700, continuationSilenceMs = Math.max(2200, silenceMs) } = {}) {
  if (!Number.isFinite(silenceMs) || silenceMs < 1 || !Number.isFinite(stabilityMs) || stabilityMs < 0
    || !Number.isFinite(finalWaitMs) || finalWaitMs < 0
    || !Number.isFinite(continuationSilenceMs) || continuationSilenceMs < silenceMs) {
    throw new TypeError('Interview endpoint timing must be finite and nonnegative.');
  }
  let finals;
  let volatile;
  let supersededVolatile;
  let retired;
  let quietSince;
  let lastChangedAt;
  let sawSpeech;
  let oversized;
  let turn;
  let clock;
  let retiredThroughMs;
  let finalGeneration;

  const time = value => {
    const next = Number.isFinite(value) ? value : Date.now();
    clock = Math.max(clock, next);
    return clock;
  };
  const ordered = () => [...finals.values(), ...(volatile ? [volatile] : [])]
    .sort((left, right) => left.startMs - right.startMs || left.order - right.order);
  const transcript = () => ordered().map(item => item.text).filter(Boolean).join(' ');
  const recoveredTranscript = () => {
    if (!supersededVolatile) return null;
    const segments = ordered();
    const overlapping = segments.filter(item => item.final && item.endMs !== null
      && item.endMs > supersededVolatile.startMs && item.startMs < supersededVolatile.endMs);
    const recovered = recoverTrailingWords(overlapping.map(item => item.text).join(' '), supersededVolatile.text);
    if (recovered === null) return null;
    return segments.map(item => item === overlapping[0] ? recovered : overlapping.includes(item) ? '' : item.text)
      .filter(Boolean).join(' ');
  };
  const retire = segment => {
    retired.push(segment);
    if (retired.length > MAX_RETIRED_SEGMENTS) retired.shift();
  };
  const clearTurn = () => {
    finals = new Map();
    volatile = null;
    supersededVolatile = null;
    lastChangedAt = null;
    sawSpeech = false;
    oversized = false;
  };
  const reset = () => {
    retired = [];
    quietSince = null;
    retiredThroughMs = -1;
    finalGeneration = 0;
    turn = 0;
    clock = -Infinity;
    clearTurn();
  };
  reset();

  return Object.freeze({
    reset,
    getTranscript: () => transcript().slice(0, MAX_QUESTION_CHARS),
    getPartial: () => ({ turnId: turn + 1, text: transcript().slice(0, MAX_QUESTION_CHARS) }),
    receive(event, now) {
      if (!event || typeof event !== 'object') return false;
      const at = time(now);
      if (event.type === 'activity' && typeof event.speaking === 'boolean') {
        if (event.speaking) {
          sawSpeech = true;
          quietSince = null;
        } else if (quietSince === null) {
          quietSince = at;
        }
        return true;
      }
      if (event.type !== 'transcript' || typeof event.segmentId !== 'string'
        || !event.segmentId || event.segmentId.length > 128
        || /[\p{Cc}\p{Cf}]/u.test(event.segmentId)
        || typeof event.text !== 'string' || typeof event.final !== 'boolean') return false;
      const text = cleanTranscriptText(event.text);
      if (!text) return false;
      const hasRange = Number.isFinite(event.startMs) && event.startMs >= 0
        && Number.isFinite(event.endMs) && event.endMs >= event.startMs;
      // A new activity epoch must open the next turn. Late finals while idle
      // commit old audio, but cannot resubmit it. Activity receipt time and
      // analyzer audio time have different origins; never compare the clocks.
      if (turn > 0 && !sawSpeech) {
        if (event.final && hasRange) retiredThroughMs = Math.max(retiredThroughMs, event.endMs);
        return false;
      }
      // Retire COMMITTED audio only, never a volatile range's inflated end.
      // A result beginning before that boundary may contain a whole new
      // utterance (including silence). Drop only wholly retired ranges. With
      // no word timings, an ambiguous straddle is accepted rather than clipped
      // or discarded: a few old words are less harmful than going deaf.
      if (hasRange && event.endMs <= retiredThroughMs) return false;
      // A volatile-only endpoint may finalize after a cough or the next speech
      // onset. Until another final commits, its original start identifies that
      // correction regardless of changed words or a shortened/extended end.
      const retiredVolatileRevision = event.final && retired.some(segment => !segment.final
        && segment.finalGeneration === finalGeneration
        && (hasRange && segment.endMs !== null ? event.startMs <= segment.startMs : event.segmentId === segment.id)
        // A newly received volatile can explicitly reuse an old start for a
        // longer utterance. Its matching final still belongs to the new turn.
        && !(hasRange && volatile && volatile.endMs !== null && segment.endMs !== null && volatile.endMs > segment.endMs
          && event.startMs === volatile.startMs && revisionText(text) === volatile.revisionText));
      if (retiredVolatileRevision) {
        if (hasRange) retiredThroughMs = Math.max(retiredThroughMs, event.endMs);
        return false;
      }
      // Remember other endpointed text/ranges as well. A new volatile spanning
      // retired audio remains usable rather than being clipped without words.
      const oldRevision = retired.some(segment => hasRange && segment.endMs !== null
        ? event.startMs >= segment.startMs && event.endMs <= segment.endMs
          && (event.endMs === segment.endMs || revisionText(text) === segment.revisionText)
        : !hasRange && event.segmentId === segment.id);
      if (oldRevision) {
        // The same audio endpoint identifies a final correction even if its
        // text/start changed. Contained matching text also covers shifted ends.
        // Neither rule blacklists a reused start carrying a longer new range.
        if (event.final && hasRange) retiredThroughMs = Math.max(retiredThroughMs, event.endMs);
        return false;
      }
      const previous = finals.get(event.segmentId);
      if (previous) return false; // Finalized text is immutable.
      const committed = [...finals.values()];
      if (hasRange && committed.some(segment => segment.endMs !== null
        && (event.final
          ? event.startMs < segment.endMs && event.endMs > segment.startMs
          : event.startMs >= segment.startMs && event.endMs <= segment.endMs))) return false;
      if (event.final && finals.size >= MAX_SEGMENTS) {
        oversized = true;
        return false;
      }
      const bounded = text.slice(0, MAX_QUESTION_CHARS + 1);
      if (bounded.length > MAX_QUESTION_CHARS) oversized = true;
      const before = transcript();
      const segment = {
        id: event.segmentId,
        text: bounded,
        revisionText: revisionText(bounded),
        final: event.final,
        startMs: hasRange ? event.startMs : (volatile?.startMs ?? finals.size),
        endMs: hasRange ? event.endMs : null,
        order: finals.size,
      };
      if (event.final) {
        finalGeneration += 1;
        finals.set(event.segmentId, segment);
        // The final still replaces the overlapping live tail. If its range
        // ends early, save that ONE hypothesis off-transcript until coverage
        // catches up (or a new volatile replaces it). Wait only the existing
        // finalization grace, then recover its extra words rather than lose
        // heard speech. Identical/word-complete finals need no extra delay.
        if (volatile && (!hasRange || volatile.endMs === null || volatile.startMs < event.endMs)) {
          supersededVolatile = hasRange && volatile.endMs !== null && event.endMs < volatile.endMs ? volatile : null;
          volatile = null;
        }
        if (supersededVolatile && (!hasRange || event.endMs >= supersededVolatile.endMs || recoveredTranscript() === null)) {
          supersededVolatile = null;
        }
      } else {
        volatile = segment;
        supersededVolatile = null;
      }
      if (before !== transcript()) lastChangedAt = at;
      if (transcript().length > MAX_QUESTION_CHARS) oversized = true;
      return true;
    },
    poll(now) {
      const at = time(now);
      if (!sawSpeech || quietSince === null || lastChangedAt === null
        || at - quietSince < silenceMs || at - lastChangedAt < stabilityMs) return null;
      const quietFor = at - quietSince;
      // finalize(through:) starts in the native helper during this pause. Give
      // its authoritative final a bounded chance to supply trailing words;
      // already-final turns retain the normal latency and a stalled analyzer
      // can never hold a turn forever.
      if ((volatile || supersededVolatile) && quietFor < silenceMs + finalWaitMs) return null;
      const text = recoveredTranscript() ?? transcript();
      if (!text) return null;
      if (needsContinuationPause(text) && quietFor < continuationSilenceMs) return null;
      if (text.length > MAX_QUESTION_CHARS) oversized = true;
      for (const segment of ordered()) {
        retire({ ...segment, finalGeneration });
        if (segment.final && segment.endMs !== null) retiredThroughMs = Math.max(retiredThroughMs, segment.endMs);
      }
      if (supersededVolatile) retire({ ...supersededVolatile, finalGeneration });
      const classified = oversized ? null : classifyInterviewCallQuestion(text);
      const endpoint = {
        id: ++turn,
        text: text.slice(0, MAX_QUESTION_CHARS),
        question: classified?.question ?? null,
        parts: classified?.parts ?? [],
        dependent: classified?.dependent ?? false,
        multipart: classified?.multipart ?? false,
        reason: oversized ? 'too-long' : classified ? 'question' : 'not-question',
      };
      clearTurn();
      return endpoint;
    },
  });
}
