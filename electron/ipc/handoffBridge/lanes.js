import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONSTANTS } from './constants.js';

export const LANE_PHASES = Object.freeze(['unread', 'awaiting', 'host', 'done', 'needs_user', 'held', 'gone']);
export const LANE_REASONS = Object.freeze([
  'user_hold', 'human_advance', 'rejection_cap', 'junk_cap', 'review_round_cap',
  'job_broken', 'render_retry', 'app_fix_required', 'canvas_unavailable', 'read_failed', 'write_failed',
  'submit_stuck', 'host_silent', 'lapsed', 'restart',
]);

export function makeChatKey(random = randomBytes) {
  const alphabetLength = CONSTANTS.CHAT_KEY_ALPHABET.length;
  // The fixed protocol alphabet has a power-of-two size. A bit mask maps the
  // uniformly random byte to equally sized buckets (unlike arbitrary modulo).
  if ((alphabetLength & (alphabetLength - 1)) !== 0) throw new RangeError('Chat-key alphabet must have a power-of-two size');
  const alphabetMask = alphabetLength - 1;
  let key = '';
  for (const byte of random(CONSTANTS.CHAT_KEY_LENGTH_CHARS)) {
    key += CONSTANTS.CHAT_KEY_ALPHABET[byte & alphabetMask];
  }
  return key;
}

// Compatibility alias for the inert B0 surface. This creates chat keys,
// never application handoff codes (those come only from the app).
export const makeHandoffCode = makeChatKey;

const EDGE_CODE_CHARS = /^[\s'"`\u2018\u2019\u201C\u201D\u200B-\u200D\u2060\uFEFF]+|[\s'"`\u2018\u2019\u201C\u201D\u200B-\u200D\u2060\uFEFF]+$/g;

// The sole handoff-code edge normalizer. Protocol adapters normalize before
// creating routing identities; deliberately oversized input remains exact so
// validation, rather than trimming, rejects it.
export function trimHandoffCode(value) {
  if (typeof value !== 'string') return '';
  return value.length > 512 ? value : value.replace(EDGE_CODE_CHARS, '');
}

/**
 * The only owner of handoff-code routing identity.  Callers use the digest
 * key for Maps and re-check the fixed-length stored digest on every hit, so a
 * caller-controlled code never selects state by a raw-string comparison.
 */
export function createHandoffCodeGuard() {
  const digest = value => createHash('sha256').update(trimHandoffCode(value)).digest();
  const key = value => digest(value).toString('hex');
  const sameDigest = (left, right) => Buffer.isBuffer(left)
    && Buffer.isBuffer(right)
    && left.length === 32
    && right.length === 32
    && timingSafeEqual(left, right);
  const equal = (left, right) => sameDigest(digest(left), digest(right));
  return Object.freeze({ canonicalize: trimHandoffCode, digest, key, sameDigest, equal });
}

export function isHandoffCodeGuard(value) {
  return Boolean(value
    && typeof value.canonicalize === 'function'
    && typeof value.digest === 'function'
    && typeof value.key === 'function'
    && typeof value.sameDigest === 'function'
    && typeof value.equal === 'function');
}

function makeCounters(value = {}) {
  return {
    rejections: Number.isInteger(value.rejections) ? value.rejections : 0,
    junkStreak: Number.isInteger(value.junkStreak) ? value.junkStreak : Number.isInteger(value.junk) ? value.junk : 0,
    revisedRounds: Number.isInteger(value.revisedRounds) ? value.revisedRounds : Number.isInteger(value.reviewRounds) ? value.reviewRounds : 0,
    errStreak: Number.isInteger(value.errStreak) ? value.errStreak : Number.isInteger(value.errors) ? value.errors : 0,
    attemptByStage: value.attemptByStage && typeof value.attemptByStage === 'object' ? { ...value.attemptByStage } : {},
  };
}

export function normalizeCurrentHandoff(handoff, readAt = 0) {
  if (!handoff) return null;
  const code = handoff.code ?? handoff.handoffCode;
  if (typeof code !== 'string' || !code || typeof handoff.stage !== 'string' || !handoff.stage
      || typeof handoff.prompt !== 'string' || !handoff.prompt) return null;
  return {
    code,
    stage: handoff.stage,
    revision: Number.isInteger(handoff.revision) ? handoff.revision : 0,
    prompt: handoff.prompt,
    promptBytes: Buffer.byteLength(handoff.prompt, 'utf8'),
    corrections: Array.isArray(handoff.corrections) ? handoff.corrections.filter(item => typeof item === 'string') : [],
    correctionPrompt: typeof handoff.correctionPrompt === 'string' ? handoff.correctionPrompt : '',
    recovered: handoff.recovered === true || handoff.correctionsRecovered === true,
    draftBytes: Number.isFinite(handoff.draftBytes)
      ? Math.max(0, handoff.draftBytes)
      : Buffer.byteLength(typeof handoff.draft === 'string' ? handoff.draft : '', 'utf8'),
    readAt,
    attempt: Number.isInteger(handoff.attempt) && handoff.attempt > 0 ? handoff.attempt : 1,
  };
}

export function createApplicationLane({ ord, jobId, canvasFilePath, releasedAt = 0, handoff = null, phase, codeGuard = createHandoffCodeGuard() } = {}) {
  if (!Number.isInteger(ord) || ord < 1 || typeof jobId !== 'string' || !jobId || typeof canvasFilePath !== 'string' || !canvasFilePath) {
    throw new TypeError('A lane requires an ordinal, job and canvas path');
  }
  const current = normalizeCurrentHandoff(handoff, releasedAt);
  const lanePhase = phase ?? (current ? 'awaiting' : 'unread');
  if (!LANE_PHASES.includes(lanePhase)) throw new TypeError('Invalid lane phase');
  const issuedCodes = new Map();
  if (current?.code) issuedCodes.set(codeGuard.key(current.code), codeGuard.digest(current.code));
  return {
    ord,
    kind: 'application',
    jobId,
    canvasFilePath,
    releasedAt,
    phase: lanePhase,
    reason: null,
    heldFrom: null,
    current,
    issuedCodes,
    acceptedFingerprints: new Set(),
    servedAt: null,
    serves: 0,
    // Memory only: the digest of the code last served, and whether the latest
    // serve repeated it.
    lastServedDigest: null,
    servedCodeAgain: false,
    // Memory only: an accepted answer the app took while this lane was detached
    // or fenced off, applied when the lane is back (see settleAcceptedElsewhere).
    acceptedElsewhere: null,
    // Per-job answer tracking (memory only, never persisted). awaitingAnswer is
    // true from the moment this lane's current prompt is served to a chat until
    // an accepted submit (or a different handoff replacing it); servedEpochN is
    // the chat ordinal that prompt went to; answeredAt is the last accepted
    // submit. The engine turns them into status only for the CURRENT chat.
    awaitingAnswer: false,
    servedEpochN: null,
    // A worker-pool session owns a live application handoff until its next
    // stage or terminal result. This is memory-only: pool aliases disappear
    // on restart and restored lanes are deliberately re-read before serving.
    servedWorkerId: null,
    // A short-lived application-pool reservation held while the engine checks
    // that a candidate bundle still exists. It is memory-only and never
    // survives a save/restart; without it concurrent workers can all probe the
    // first available lane before any one of them marks it served.
    pendingWorkerId: null,
    answeredAt: null,
    submittedAt: null,
    // Floor for the quiet clock (memory only): set when the lane comes back
    // from a hold, a pause or a re-read, so that time is not counted as quiet.
    quietFrom: null,
    hostSince: null,
    counters: makeCounters(),
    snapshot: null,
    inFlight: { read: null, status: null, submit: null },
    retained: null,
  };
}

export function rehydrateApplicationLane(value, now = 0) {
  const lane = createApplicationLane({
    ord: value.ord,
    jobId: value.jobId,
    canvasFilePath: value.canvasFilePath,
    releasedAt: value.releasedAt,
    phase: LANE_PHASES.includes(value.phase) ? value.phase : 'unread',
  });
  lane.reason = LANE_REASONS.includes(value.reason) ? value.reason : null;
  lane.heldFrom = LANE_PHASES.includes(value.heldFrom) ? value.heldFrom : null;
  lane.counters = makeCounters(value.counters);
  if (!['held', 'needs_user'].includes(lane.phase)) holdLane(lane, 'restart', now);
  // `changedAt` is memory only, so every restored lane (including one already
  // held on disk) starts its "in this phase" clock at the restore.
  lane.changedAt = now;
  return lane;
}

export function holdLane(lane, reason = 'user_hold', now = 0) {
  if (!LANE_REASONS.includes(reason)) throw new TypeError('Invalid lane reason');
  if (lane.phase !== 'held') lane.heldFrom = ['done', 'gone', 'needs_user'].includes(lane.phase) ? 'unread' : lane.phase;
  // A hold ends the wait on the chat: when the lane comes back nothing has been
  // re-served, so it owes no answer and has no serve time until the next get.
  lane.awaitingAnswer = false;
  lane.servedAt = null;
  lane.servedWorkerId = null;
  lane.pendingWorkerId = null;
  // ...and the serve that just ended is not a "repeat" if the same code goes out
  // again after the hold.
  lane.lastServedDigest = null;
  lane.servedCodeAgain = false;
  lane.phase = ['job_broken', 'render_retry', 'app_fix_required', 'canvas_unavailable', 'read_failed', 'write_failed', 'submit_stuck', 'host_silent'].includes(reason)
    ? 'needs_user'
    : 'held';
  lane.reason = reason;
  lane.snapshot = null;
  lane.changedAt = now;
  return lane;
}

export function resumeLane(lane) {
  if (['held', 'needs_user'].includes(lane.phase)) {
    // A terminal phase is not a place to resume to: the lane would come back
    // with no snapshot and never age out. Re-read it instead.
    // A human-advance hold means the prompt this lane held is retired, so it
    // never resumes to 'awaiting' on that stale code; it re-reads instead.
    lane.phase = lane.reason !== 'human_advance' && LANE_PHASES.includes(lane.heldFrom) && !['done', 'gone'].includes(lane.heldFrom) ? lane.heldFrom : 'unread';
    lane.reason = null;
    lane.heldFrom = null;
    lane.snapshot = null;
  }
  return lane;
}

export function restoreLane(lane, now = 0) {
  if (!['held', 'needs_user'].includes(lane.phase)) holdLane(lane, 'restart', now);
  return lane;
}

export function indexLaneCode(index, lane, metadata = {}, limit = CONSTANTS.CODE_INDEX_PER_LANE, codeGuard = createHandoffCodeGuard()) {
  const code = lane?.current?.code;
  if (!code) return index;
  const codeDigest = codeGuard.digest(code);
  index.set(codeGuard.key(code), { lane, laneOrd: lane.ord, stage: lane.current.stage, revision: lane.current.revision, codeDigest, ...metadata });
  const own = [...index.entries()].filter(([, entry]) => entry?.laneOrd === lane.ord);
  while (own.length > limit) index.delete(own.shift()[0]);
  return index;
}

export function tombstoneCode(tombstones, code, reason, metadata = {}, limit = CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard = createHandoffCodeGuard()) {
  if (!code) return tombstones;
  const codeDigest = codeGuard.digest(code);
  const key = codeGuard.key(code);
  tombstones.delete(key);
  tombstones.set(key, { reason, codeDigest, ...metadata });
  while (tombstones.size > limit) tombstones.delete(tombstones.keys().next().value);
  return tombstones;
}

export function rememberIssuedCode(lane, code, codeGuard = createHandoffCodeGuard()) {
  if (!code) return lane;
  const key = codeGuard.key(code);
  lane.issuedCodes.set(key, codeGuard.digest(code));
  while (lane.issuedCodes.size > CONSTANTS.CODE_INDEX_PER_LANE) lane.issuedCodes.delete(lane.issuedCodes.keys().next().value);
  return lane;
}

export function isHumanAdvance(lane, handoffCode, codeGuard = createHandoffCodeGuard()) {
  if (!lane?.current?.code || typeof handoffCode !== 'string') return false;
  if (codeGuard.equal(handoffCode, lane.current.code)) return false;
  const digest = codeGuard.digest(handoffCode);
  const stored = lane.issuedCodes?.get?.(codeGuard.key(handoffCode));
  return !codeGuard.sameDigest(digest, stored);
}

export function remainingCounts(lanes) {
  const counts = { ready: 0, working: 0, needsYou: 0 };
  for (const lane of lanes) {
    if (lane.phase === 'awaiting') counts.ready++;
    else if (['unread', 'host'].includes(lane.phase)) counts.working++;
    else if (['held', 'needs_user'].includes(lane.phase)) counts.needsYou++;
  }
  return counts;
}
