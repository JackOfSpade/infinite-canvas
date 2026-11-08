/**
 * Deterministic simulation harness for the live practice-interview call engine.
 * Drives the REAL createPracticeCallEngine with a virtual clock, a fake helper, fake sessions and a fake voice.
 * No real time, network or processes. The pause-heavy sweep draws its within-answer pause durations from REAL AMI data
 * (scripts/fixtures/ami-within-turn-pauses.json); everything else is SYNTHETIC: latencies are sampled from lognormals fitted to the
 * Phase 0 p50/p95 numbers and the candidate is scripted (see scripts/fixtures/interview-practice-call-scenarios.mjs).
 */
import { createPracticeCallEngine, DEFAULT_CALL_THRESHOLDS } from '../electron/interviewPracticeCallEngine.js';
import { SCENARIOS, getScenario, AMI_PAUSES, PAUSE_SOURCE_LINE } from './fixtures/interview-practice-call-scenarios.mjs';

export const HELPER_OFFSET = 5000; // helper atMs = clock ms - 5000
export const SWEEP_SPECULATE_MS = [400, 500, 600, 800];
export const SWEEP_COMMIT_MS = [900, 1200, 1500, 2000, 2500];
export const SWEEP_VOICE_GATE_MS = [0, 900, 1200];
export const SWEEP_LISTEN_ACCURACY = [1.0, 0.9, 0.8];
export const SUMMARY_MAX_CUT_IN_RATE = 0.05;
export const SUMMARY_ROWS = 5;
export const BEST_RULE = { maxCutInRate: 0.02, maxP95Ms: 2500 };

/** Phase 0 measured latencies (ms): the fakes sample exactly these distributions. */
export const PHASE0 = Object.freeze({
  opener: { p50: 700, p95: 1170 },
  main: { p50: 1398, p95: 2040 },
  classifier: { p50: 900, p95: 1087 },
  voice: { p50: 546, p95: 574 },
});

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** mu = ln p50, sigma = (ln p95 - ln p50) / 1.645. */
export function lognormalParams({ p50, p95 }) {
  return { mu: Math.log(p50), sigma: (Math.log(p95) - Math.log(p50)) / 1.645 };
}

export function createLognormal(rand, spec) {
  const { mu, sigma } = lognormalParams(spec);
  return () => {
    const u = 1 - rand();
    const v = rand();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.exp(mu + sigma * z);
  };
}

/** One independent PRNG stream per fake so a change in one fake never shifts another's samples. */
export function createLatencies(seed) {
  const stream = index => mulberry32(Math.imul(seed >>> 0, 2654435761) + index * 40503 + 17);
  const helper = stream(5);
  return {
    opener: createLognormal(stream(1), PHASE0.opener),
    main: createLognormal(stream(2), PHASE0.main),
    classifier: createLognormal(stream(3), PHASE0.classifier),
    voice: createLognormal(stream(4), PHASE0.voice),
    cancelLagMs: () => 1 + Math.floor(helper() * 15),
  };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const flush = async () => { for (let step = 0; step < 30; step += 1) await Promise.resolve(); };

/** Virtual clock: a priority queue of timers; advanceTo runs due timers in time order, flushing microtasks between. */
export function createVirtualClock() {
  let time = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { seq += 1; timers.set(seq, { fn, due: time + Math.max(0, Number(ms) || 0), seq }); return seq; },
    clearTimeout(handle) { timers.delete(handle); },
    pending: () => timers.size,
    async advanceTo(target) {
      for (;;) {
        let next = null;
        for (const [id, item] of timers) {
          if (item.due <= target && (!next || item.due < next.due || (item.due === next.due && item.seq < next.seq))) next = { id, ...item };
        }
        if (!next) break;
        timers.delete(next.id);
        time = Math.max(time, next.due);
        next.fn();
        await flush();
      }
      time = Math.max(time, target);
      await flush();
    },
  };
}

/** Independent seeded streams for the opener's and the main's <listen/> decisions (never shared with latencies). */
function createListenDraws(seed) {
  const stream = index => mulberry32(Math.imul(seed >>> 0, 2246822519) + index * 7919 + 101);
  return { opener: stream(1), main: stream(2) };
}

/** True when the fake model should answer <listen/>: always for scenario-marked unfinished answers, and during a
 * within-answer pause with probability listenAccuracy. Turn-final silences (inPause false) never get <listen/>. */
function wantsListen(world, who) {
  if (world.unfinished) return true;
  if (!world.inPause) return false;
  return world.listenDraws[who]() < world.listenAccuracy;
}

function createWorld(clock, scenario, seed, listenAccuracy = 1) {
  const world = {
    clock, scenario, seed, latency: createLatencies(seed), engine: null, engineEnded: false,
    listenAccuracy, listenDraws: createListenDraws(seed), inPause: false,
    earOn: false, earInPause: false, smartTurnAccuracy: null, earAnswers: [],
    earDraws: mulberry32(Math.imul(seed >>> 0, 1103515245) + 12345),
    commands: [], helperLog: [], playbackStarts: [], plays: 0, utterancesEnded: 0,
    inflight: 0, voicePending: 0, lastActivity: 0,
    unfinished: false, overlapKind: 'ack', lastTurnEndAt: -1, skipWait: false,
    mainMessages: [], openerMessages: [], classifierCalls: [], restarts: [], voice: [], mainCalls: [],
    counts: { opener: 0, main: 0, classifier: 0 }, failFired: false,
    pauseWindows: [], answers: [], spoken: [],
  };
  world.touch = () => { world.lastActivity = clock.now(); };
  return world;
}

export const DEFAULT_SMART_TURN_ACCURACY = 0.85;

/** Fake ear: Smart Turn end-of-turn, floor bid and voice note. endOfTurn answers 0.2 ("unfinished") inside a
 * within-answer pause with probability smartTurnAccuracy and 0.8 ("finished") everywhere else, i.e. at turn ends.
 * floorBid follows the scenario's overlap label: an 'ack' overlap bids 'continue', an 'interrupt' bids 'pause'. */
function createFakeEar(world, { smartTurnAccuracy = DEFAULT_SMART_TURN_ACCURACY } = {}) {
  world.earOn = true;
  world.smartTurnAccuracy = smartTurnAccuracy;
  return {
    async endOfTurn(atMs) {
      const held = world.earInPause && world.earDraws() < smartTurnAccuracy;
      const probability = held ? 0.2 : 0.8;
      world.earAnswers.push({ atMs, inPause: world.earInPause, held, probability });
      return probability;
    },
    async floorBid() {
      return { decision: world.overlapKind === 'interrupt' ? 'pause' : 'continue' };
    },
    async voiceNote() { return null; },
  };
}

/** Fake helper: turns engine audio commands into playback events and the scripted candidate into vad/transcript events.
 * Exported so the pause/resume behaviour can be unit tested without a whole scenario. */
export function createFakeHelper(world) {
  const { clock } = world;
  const utterances = new Map();
  const nowHelper = () => clock.now() - HELPER_OFFSET;
  const record = command => { world.commands.push({ ...command, at: clock.now() }); world.touch(); };
  const sendPlayback = (u, state, positionMs) => {
    world.helperLog.push({ type: 'playback', state, utteranceId: u.id, positionMs, at: clock.now() });
    world.touch();
    world.engine.helperEvent({ type: 'playback', utteranceId: u.id, state, positionMs, atMs: nowHelper() });
  };
  // A paused utterance keeps the position it was paused at; resume restarts the clock from there.
  const position = u => (u.started ? Math.min(u.pos + (u.paused ? 0 : clock.now() - u.posAt), u.pushedMs) : 0);

  function tick(u) {
    if (u.over || u.paused) return;
    u.pos = position(u);
    u.posAt = clock.now();
    sendPlayback(u, 'position', u.pos);
    if (u.over) return;
    if (u.ended && u.pos >= u.pushedMs - 1e-6) {
      u.over = true;
      world.utterancesEnded += 1;
      sendPlayback(u, 'finished', u.pushedMs);
      return;
    }
    u.timer = clock.setTimeout(() => tick(u), 50);
  }

  function start(u) {
    if (u.over) return;
    u.started = true;
    u.pos = 0;
    u.posAt = clock.now();
    world.playbackStarts.push({ utteranceId: u.id, at: clock.now() });
    sendPlayback(u, 'started', 0);
    u.timer = clock.setTimeout(() => tick(u), 50);
  }

  const audio = {
    play(id, rate) {
      record({ type: 'play', utteranceId: id, sampleRate: rate });
      world.plays += 1;
      utterances.set(id, { id, rate, pushedMs: 0, pos: 0, posAt: 0, started: false, scheduled: false, ended: false, over: false, paused: false, timer: null });
    },
    pushAudio(id, buffer) {
      record({ type: 'pushAudio', utteranceId: id, bytes: buffer.length });
      const u = utterances.get(id);
      if (!u || u.over) return;
      u.pushedMs += (buffer.length / 2 / u.rate) * 1000;
      if (!u.scheduled) { u.scheduled = true; clock.setTimeout(() => start(u), 40); }
    },
    endUtterance(id) {
      record({ type: 'endUtterance', utteranceId: id });
      const u = utterances.get(id);
      if (u) u.ended = true;
    },
    // Pause-then-decide: the helper freezes playback between pause and resume and reports both states.
    pause(id) {
      record({ type: 'pause', utteranceId: id });
      const u = utterances.get(id);
      if (!u || u.over || u.paused) return;
      u.pos = position(u);
      u.posAt = clock.now();
      u.paused = true;
      clock.clearTimeout(u.timer);
      u.timer = null;
      sendPlayback(u, 'paused', u.pos);
    },
    resume(id) {
      record({ type: 'resume', utteranceId: id });
      const u = utterances.get(id);
      if (!u || u.over || !u.paused) return;
      u.paused = false;
      u.posAt = clock.now();
      sendPlayback(u, 'resumed', u.pos);
      u.timer = clock.setTimeout(() => tick(u), 50);
    },
    cancel(id) {
      const u = utterances.get(id);
      const positionMs = u && !u.over ? position(u) : null;
      record({ type: 'cancel', utteranceId: id, positionMs });
      if (!u || u.over) return;
      u.over = true;
      clock.clearTimeout(u.timer);
      clock.setTimeout(() => { world.utterancesEnded += 1; sendPlayback(u, 'cancelled', positionMs); }, world.latency.cancelLagMs());
    },
    mute(muted) { record({ type: 'mute', muted }); },
  };

  const vad = speaking => {
    world.touch();
    world.engine.helperEvent({ type: 'vad', speaking, atMs: nowHelper() });
  };
  const transcript = (text, segmentId, startClock, endClock, final) => {
    world.touch();
    world.engine.helperEvent({
      type: 'transcript', text, segmentId, final, startMs: startClock - HELPER_OFFSET, endMs: endClock - HELPER_OFFSET,
    });
  };
  const level = () => world.engine.helperEvent({ type: 'level', rms: 0.1, atMs: nowHelper() });
  return { audio, vad, transcript, level };
}

const CHARS_PER_SECOND = 15;
const SAMPLE_RATE = 24000;
const abortError = () => Object.assign(new Error('CANCELLED'), { name: 'AbortError', code: 'CANCELLED' });

/** Fake voice: 15 characters per second of 16-bit mono audio, first audio after a sampled time-to-first-audio. */
function createFakeVoice(world) {
  const { clock } = world;
  return {
    open({ utteranceId, signal } = {}) {
      const rec = { utteranceId, texts: [], words: [], audioMs: 0 };
      world.voice.push(rec);
      const timers = new Set();
      let audioCb = () => {};
      let wordsCb = () => {};
      let aborted = false;
      let firstSendAt = null;
      let ttfa = 0;
      let lastDelivery = 0;
      let pending = 0;
      let waiter = null;
      const release = () => { if (waiter && pending === 0) { const done = waiter; waiter = null; done(); } };
      const stop = () => {
        aborted = true;
        for (const timer of timers) clock.clearTimeout(timer);
        timers.clear();
        world.voicePending -= pending;
        pending = 0;
        release();
      };
      signal?.addEventListener('abort', stop, { once: true });
      const stream = { sampleRate: SAMPLE_RATE };
      stream.onAudio = cb => { audioCb = cb; };
      stream.onWords = cb => { wordsCb = cb; };
      stream.sendText = text => {
        if (aborted) return;
        rec.texts.push(text);
        const now = clock.now();
        if (firstSendAt === null) { firstSendAt = now; ttfa = world.latency.voice(); }
        const at = Math.max(now, firstSendAt + ttfa, lastDelivery);
        lastDelivery = at;
        const durationMs = (text.length / CHARS_PER_SECOND) * 1000;
        const bytes = Math.round((durationMs / 1000) * SAMPLE_RATE) * 2;
        const startMs = rec.audioMs;
        rec.audioMs += durationMs;
        const list = text.split(/\s+/).filter(Boolean);
        const words = list.map((word, index) => ({
          word, startMs: startMs + (index * durationMs) / list.length, endMs: startMs + ((index + 1) * durationMs) / list.length,
        }));
        pending += 1;
        world.voicePending += 1;
        const timer = clock.setTimeout(() => {
          timers.delete(timer);
          if (aborted) return;
          pending -= 1;
          world.voicePending -= 1;
          world.touch();
          rec.words.push(...words);
          wordsCb(words);
          audioCb(Buffer.alloc(bytes));
          release();
        }, at - now);
        timers.add(timer);
      };
      stream.finish = () => new Promise(resolve => {
        if (aborted || pending === 0) return resolve();
        waiter = resolve;
      });
      stream.cancel = stop;
      return stream;
    },
  };
}

/** Runs one fake model call: timed deltas, then a result (or an injected failure); honours the AbortSignal. */
function runCall(world, signal, { steps = [], end }) {
  const { clock } = world;
  return new Promise((resolve, reject) => {
    const timers = [];
    let settled = false;
    const settle = fn => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clock.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      world.inflight -= 1;
      world.touch();
      fn();
    };
    function onAbort() { settle(() => reject(abortError())); }
    world.inflight += 1;
    world.touch();
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const step of steps) timers.push(clock.setTimeout(() => { if (!settled) { world.touch(); step.fn(); } }, step.at));
    timers.push(clock.setTimeout(() => settle(() => (end.error ? reject(end.error) : resolve(end.result))), end.at));
  });
}

const normalizeLine = line => (typeof line === 'string' ? { say: line } : line);

function interviewerLine(world, index) {
  const lines = world.scenario.interviewer || [];
  if (!lines.length) return null;
  if (index < lines.length) return normalizeLine(lines[index]);
  return world.scenario.loopLines ? normalizeLine(lines[index % lines.length]) : null;
}

/** Deltas the real reply parser understands: optional <chat> block first, optional <end-call/> last. */
function lineDeltas(line) {
  const sentences = String(line.say || '').split(/(?<=[.?!])\s+/).filter(Boolean);
  const deltas = sentences.map((sentence, index) => (index ? ` ${sentence}` : sentence));
  if (line.chat) {
    const block = `<chat>${line.chat}</chat>`;
    if (deltas.length) deltas[0] = `${block} ${deltas[0]}`; else deltas.push(block);
  }
  if (line.endCall) {
    if (deltas.length) deltas[deltas.length - 1] += '<end-call/>'; else deltas.push('<end-call/>');
  }
  return deltas;
}

function injectedFailure(world, kind, callNo) {
  const spec = world.scenario.failOn;
  if (!spec || world.failFired || spec.kind !== kind || spec.turn !== callNo) return null;
  world.failFired = true;
  return { at: 100, error: new Error(`injected ${kind} failure`) };
}

function createFakeSession(world, kind) {
  const session = { kind, closed: false, close() { this.closed = true; } };
  session.turn = (message, { signal, onDelta } = {}) => {
    const callNo = world.counts[kind];
    world.counts[kind] += 1;
    const failure = injectedFailure(world, kind, callNo);
    if (kind === 'opener') {
      world.openerMessages.push(message);
      const first = world.latency.opener();
      const listen = wantsListen(world, 'opener');
      const text = listen ? '<listen/>' : (world.scenario.reaction ?? 'Got it,');
      return runCall(world, signal, {
        steps: [{ at: first, fn: () => onDelta?.(text) }],
        end: failure || { at: first + 150, result: { text, control: listen ? 'listen' : undefined } },
      });
    }
    if (kind === 'classifier') {
      world.classifierCalls.push({ at: world.clock.now(), message });
      const total = world.latency.classifier();
      const text = world.overlapKind === 'interrupt' ? 'interruption' : 'acknowledgement'; // label only, never the words
      return runCall(world, signal, { end: failure || { at: total, result: { text } } });
    }
    const index = world.plays;
    world.mainMessages.push(message);
    const call = { index, signal, at: world.clock.now() };
    world.mainCalls.push(call);
    signal?.addEventListener('abort', () => { call.abortedAt = world.clock.now(); call.playsAtAbort = world.plays; }, { once: true });
    const line = wantsListen(world, 'main') ? null : interviewerLine(world, index);
    const first = world.latency.main();
    if (!line) {
      return runCall(world, signal, {
        steps: [{ at: first, fn: () => onDelta?.('<listen/>') }],
        end: failure || { at: first, result: { text: '<listen/>', control: 'listen' } },
      });
    }
    const deltas = lineDeltas(line);
    const steps = deltas.map((delta, step) => ({ at: first + step * 400, fn: () => onDelta?.(delta) }));
    const last = steps.length ? steps[steps.length - 1].at : first;
    return runCall(world, signal, {
      steps,
      end: failure || { at: last, result: { text: deltas.join(''), endCall: !!line.endCall } },
    });
  };
  return session;
}

function createSessionFactory(world) {
  const sessions = { opener: createFakeSession(world, 'opener'), main: createFakeSession(world, 'main'), classifier: createFakeSession(world, 'classifier') };
  const restartSession = async (kind, info = {}) => {
    world.restarts.push({ kind, transcriptText: info.transcriptText });
    await new Promise(resolve => world.clock.setTimeout(resolve, 150));
    return createFakeSession(world, kind);
  };
  return { sessions, restartSession };
}

// ---- scripted candidate -----------------------------------------------------
const REACTION_MS = 400; // the candidate reacts this long after the interviewer stops
const UNFINISHED_GAP_MS = 2500; // pause before continuing an answer the scenario marks unfinished
const QUIET_MS = 2500;
const STEP_MS = 100;
const DEFAULT_MAX_MS = 600000;

const sleep = (world, ms) => new Promise(resolve => world.clock.setTimeout(resolve, ms));
async function waitFor(world, condition) {
  while (!world.engineEnded && !condition()) await sleep(world, 20);
}
const answered = world => world.playbackStarts.some(item => item.at >= world.lastTurnEndAt)
  && world.plays === world.utterancesEnded && world.inflight === 0 && world.voicePending === 0;

async function waitAnswered(world) {
  if (world.skipWait) { world.skipWait = false; await sleep(world, UNFINISHED_GAP_MS); return; }
  await waitFor(world, () => answered(world));
  await sleep(world, REACTION_MS);
}

/** Waits for the interviewer's reply to the candidate's last turn to start playing, then `afterMs` more. */
async function waitPlaybackStart(world, afterMs = 0) {
  await waitFor(world, () => world.playbackStarts.some(item => item.at >= world.lastTurnEndAt));
  const start = world.playbackStarts.find(item => item.at >= world.lastTurnEndAt);
  if (!start) return;
  const delay = start.at + afterMs - world.clock.now();
  if (delay > 0) await sleep(world, delay);
}

const wordsOf = text => String(text ?? '').split(/\s+/).filter(Boolean);

function splitGroups(words, groups) {
  const count = Math.max(1, Math.min(groups, words.length));
  const out = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    const size = Math.floor(words.length / count) + (index < words.length % count ? 1 : 0);
    out.push(words.slice(at, at + size));
    at += size;
  }
  return out;
}

/** One uninterrupted phrase: vad on, volatile partials every ~300 ms, final at the end, all 250 ms late. */
async function speakPhrase(world, helper, words, durationMs, segmentId) {
  const { clock } = world;
  const start = clock.now();
  const full = words.join(' ');
  helper.vad(true);
  for (let at = 300; at < durationMs; at += 300) {
    const count = Math.floor((words.length * at) / durationMs);
    if (count >= 1) clock.setTimeout(() => helper.transcript(words.slice(0, count).join(' '), segmentId, start, start + at, false), at + 250);
  }
  clock.setTimeout(() => helper.transcript(full, segmentId, start, start + durationMs, true), durationMs + 250);
  await sleep(world, durationMs);
  helper.vad(false);
  return { start, end: clock.now() };
}

async function doSay(world, helper, action, index) {
  await waitAnswered(world);
  if (world.engineEnded) return;
  const words = wordsOf(action.text);
  const durationMs = action.durationMs ?? Math.max(600, words.length * 330);
  const pauses = action.pausesMs || [];
  const groups = splitGroups(words, pauses.length + 1);
  world.unfinished = !!action.unfinished;
  let answerStart = null;
  let pauseStart = null;
  let end = null;
  for (let phrase = 0; phrase < groups.length; phrase += 1) {
    if (phrase > 0) {
      await sleep(world, pauses[phrase - 1]);
      world.inPause = false;
      world.pauseWindows.push({ start: pauseStart, end: world.clock.now(), pauseMs: pauses[phrase - 1] });
    }
    // The ear answers right after this phrase's vad end: a within-answer pause follows unless this is the last phrase.
    world.earInPause = phrase < groups.length - 1;
    const span = await speakPhrase(world, helper, groups[phrase], (durationMs * groups[phrase].length) / words.length, `say${index}-${phrase}`);
    world.inPause = phrase < groups.length - 1; // a within-answer pause follows; the last phrase is followed by the turn-final silence
    if (answerStart === null) answerStart = span.start;
    pauseStart = span.end;
    end = span.end;
  }
  world.answers.push({ start: answerStart, end, text: action.text });
  world.lastTurnEndAt = world.clock.now();
  world.skipWait = !!action.unfinished;
}

async function doOverlap(world, helper, action, index) {
  await waitPlaybackStart(world, action.atMsAfterPlaybackStart ?? 0);
  if (world.engineEnded) return;
  const words = wordsOf(action.text);
  world.overlapKind = action.kind === 'interrupt' ? 'interrupt' : 'ack';
  world.earInPause = false; // overlap speech is not a within-answer pause
  await speakPhrase(world, helper, words, action.durationMs ?? Math.max(300, words.length * 350), `overlap${index}`);
  if (action.kind === 'interrupt') world.lastTurnEndAt = world.clock.now();
}

async function perform(world, helper, action, index) {
  const engine = world.engine;
  switch (action.type) {
    case 'say': return doSay(world, helper, action, index);
    case 'overlap': return doOverlap(world, helper, action, index);
    case 'wait':
      if (action.afterInterviewer !== false) await waitAnswered(world);
      return sleep(world, action.ms);
    case 'typeChat':
      if (action.during) await waitPlaybackStart(world, action.atMsAfterPlaybackStart ?? 0);
      else await waitAnswered(world);
      if (world.engineEnded) return undefined;
      world.overlapKind = action.kind === 'interrupt' ? 'interrupt' : 'ack';
      engine.typed(action.text);
      world.lastTurnEndAt = world.clock.now();
      return undefined;
    case 'typingStart': engine.typing(true); return undefined;
    case 'typingStop': engine.typing(false); return undefined;
    case 'hangUp':
      await waitPlaybackStart(world, action.atMsAfterPlaybackStart ?? 1500);
      engine.hangUp();
      return undefined;
    default: throw new Error(`unknown scenario action: ${action.type}`);
  }
}

/** thresholds are passed straight to the engine (speculateMs, commitMs, voiceGateMs, ...); listenAccuracy defaults to
 * the scenario's value, else 1.0. ear: { smartTurnAccuracy } installs the fake Smart Turn ear; false/null leaves it off. */
export async function runScenario(scenario, { thresholds = DEFAULT_CALL_THRESHOLDS, seed = 1, listenAccuracy, ear = false } = {}) {
  const accuracy = listenAccuracy ?? scenario.listenAccuracy ?? 1;
  const clock = createVirtualClock();
  const world = createWorld(clock, scenario, seed, accuracy);
  const fakeEar = ear ? createFakeEar(world, typeof ear === 'object' ? ear : {}) : undefined;
  const helper = createFakeHelper(world);
  const voice = createFakeVoice(world);
  const { sessions, restartSession } = createSessionFactory(world);
  const events = [];
  let ids = 0;
  const engine = createPracticeCallEngine({
    clock, sessions, restartSession, audio: helper.audio, voice, ear: fakeEar,
    thresholds: { ...DEFAULT_CALL_THRESHOLDS, ...thresholds },
    onEvent: event => {
      events.push({ ...event, atClockMs: clock.now() });
      if (event.type === 'ended') world.engineEnded = true;
    },
    newId: () => `utt${++ids}`,
  });
  world.engine = engine;
  const actions = typeof scenario.actions === 'function' ? scenario.actions(seed) : scenario.actions;
  let scriptDone = false;
  const script = (async () => {
    for (let index = 0; index < actions.length && !world.engineEnded; index += 1) await perform(world, helper, actions[index], index);
    scriptDone = true;
  })();
  script.catch(error => { world.scriptError = error; scriptDone = true; });

  engine.start({ greeting: true });
  await flush();
  helper.level();
  const maxMs = scenario.maxMs ?? DEFAULT_MAX_MS;
  let endedAt = null;
  while (clock.now() < maxMs) {
    await clock.advanceTo(clock.now() + STEP_MS);
    if (world.engineEnded) {
      endedAt = endedAt ?? clock.now();
      if (clock.now() - endedAt >= 3000) break;
      continue;
    }
    const idle = world.inflight === 0 && world.voicePending === 0 && world.plays === world.utterancesEnded;
    if (scriptDone && idle && clock.now() - world.lastActivity >= QUIET_MS) break;
  }
  if (world.scriptError) throw world.scriptError;
  return collect(world, engine, events, scriptDone);
}

/** A cut-in is an utterance whose playback started inside a within-answer pause (the candidate then resumes).
 * Talk-over runs from the candidate's resume to the engine's cancel command, else to the playback end. */
function measureCutIns(world, endedAt) {
  const list = [];
  for (const start of world.playbackStarts) {
    const window = world.pauseWindows.find(item => start.at >= item.start && start.at < item.end);
    if (!window) continue;
    const cancel = world.commands.find(command => command.type === 'cancel' && command.utteranceId === start.utteranceId);
    const over = world.helperLog.find(item => item.utteranceId === start.utteranceId && (item.state === 'finished' || item.state === 'cancelled'));
    const stopAt = cancel ? cancel.at : (over ? over.at : Math.min(world.clock.now(), endedAt));
    list.push({
      utteranceId: start.utteranceId, startedAt: start.at, resumeAt: window.end, pauseMs: window.pauseMs,
      talkOverMs: Math.max(0, stopAt - window.end), cancelled: !!cancel,
    });
  }
  return list;
}

/** Characters sent to the fake voice for replies that were discarded (never heard) or cut in. Uses the engine's
 * 'discarded' events' voiceCharsSent when present, else the fake voice's own per-utterance count. */
function countWastedVoiceChars(world, events, cutInList) {
  const charsOf = new Map(world.voice.map(rec => [rec.utteranceId, rec.texts.reduce((sum, text) => sum + text.length, 0)]));
  const heard = new Set(world.playbackStarts.map(item => item.utteranceId));
  const wasted = new Set(cutInList.map(item => item.utteranceId));
  for (const rec of world.voice) if (!heard.has(rec.utteranceId)) wasted.add(rec.utteranceId);
  let extra = 0;
  for (const event of events) {
    if (event.type !== 'discarded') continue;
    const reported = Number.isFinite(event.voiceCharsSent) ? event.voiceCharsSent : null;
    if (event.utteranceId !== undefined && charsOf.has(event.utteranceId)) {
      if (reported !== null) charsOf.set(event.utteranceId, reported);
      wasted.add(event.utteranceId);
    } else if (reported !== null) extra += reported;
  }
  let total = extra;
  for (const id of wasted) total += charsOf.get(id) || 0;
  return total;
}

function collect(world, engine, events, scriptDone) {
  const endedEvent = events.find(event => event.type === 'ended') || null;
  const endedAt = endedEvent ? endedEvent.atClockMs : Infinity;
  const timings = events.filter(event => event.type === 'timing');
  const cutInList = measureCutIns(world, endedAt);
  const cutIns = cutInList.length;
  const wastedVoiceChars = countWastedVoiceChars(world, events, cutInList);
  const discarded = world.mainCalls.filter(call => call.abortedAt !== undefined
    && call.abortedAt < endedAt && call.playsAtAbort === call.index).length;
  return {
    scenario: world.scenario.name, seed: world.seed, earOn: world.earOn, smartTurnAccuracy: world.smartTurnAccuracy,
    earAnswers: world.earAnswers, speculations: Math.max(0, world.mainCalls.length - 1), commands: world.commands, transcript: engine.state().transcript,
    events, mainMessages: world.mainMessages, timings, cutIns, cutInList, wastedVoiceChars, listenAccuracy: world.listenAccuracy,
    talkOverMsTotal: cutInList.reduce((sum, item) => sum + item.talkOverMs, 0), discarded, ended: endedEvent,
    openerMessages: world.openerMessages, classifierCalls: world.classifierCalls, restarts: world.restarts,
    voice: world.voice, helperLog: world.helperLog, answers: world.answers, pauseWindows: world.pauseWindows,
    incomplete: !scriptDone, durationMs: world.clock.now(),
  };
}

// ---- threshold sweep --------------------------------------------------------
const seedList = seeds => (Array.isArray(seeds) ? seeds : Array.from({ length: Math.max(1, Number(seeds) || 1) }, (_, index) => index + 1));
const round = (value, digits = 1) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

/** Best pair: lowest p95 among pairs with cut-in rate <= 2% and p95 <= 2500 ms; else the lowest cut-in pair. */
export function chooseBest(rows, rule = BEST_RULE) {
  const byCost = (a, b) => a.p95Ms - b.p95Ms || a.falseCutInRate - b.falseCutInRate || a.commitMs - b.commitMs || a.speculateMs - b.speculateMs;
  const eligible = rows.filter(row => row.falseCutInRate <= rule.maxCutInRate && row.p95Ms !== null && row.p95Ms <= rule.maxP95Ms);
  if (eligible.length) return { qualified: true, row: [...eligible].sort(byCost)[0] };
  const fallback = [...rows].sort((a, b) => a.falseCutInRate - b.falseCutInRate || (a.p95Ms ?? Infinity) - (b.p95Ms ?? Infinity) || a.commitMs - b.commitMs);
  return { qualified: false, row: fallback[0] || null };
}

export async function runSweep({
  seeds = 5, scenario = getScenario('pause-heavy-answers'), speculateMs = SWEEP_SPECULATE_MS, commitMs = SWEEP_COMMIT_MS,
  voiceGateMs = SWEEP_VOICE_GATE_MS, listenAccuracy = SWEEP_LISTEN_ACCURACY, ear = [false],
} = {}) {
  const seedsUsed = seedList(seeds);
  const rows = [];
  for (const accuracy of listenAccuracy) {
    for (const useEar of ear) {
      for (const speculate of speculateMs) {
        for (const commit of commitMs) {
          if (commit <= speculate) continue;
          for (const gate of voiceGateMs) {
            if (gate > commit) continue;
            rows.push(await sweepRow(scenario, seedsUsed, { speculateMs: speculate, commitMs: commit, voiceGateMs: gate }, accuracy, useEar));
          }
        }
      }
    }
  }
  return {
    seeds: seedsUsed, rule: BEST_RULE, rows, best: chooseBest(rows), summary: summarizeSweep(rows),
    pauseSource: { file: scenario.pauseSource ?? null, line: PAUSE_SOURCE_LINE, count: AMI_PAUSES.pausesMs.length },
    scenarioLabel: scenario.label ?? null,
  };
}

// ear: false runs the sweep with the ear off; true installs the fake Smart Turn ear at DEFAULT_SMART_TURN_ACCURACY.
const earOption = useEar => (useEar ? { smartTurnAccuracy: DEFAULT_SMART_TURN_ACCURACY } : false);

async function sweepRow(scenario, seedsUsed, thresholds, listenAccuracy, useEar = false) {
  {
    {
      let answers = 0;
      let cutIns = 0;
      let talkOver = 0;
      let wasted = 0;
      let discarded = 0;
      let speculations = 0;
      const latencies = [];
      for (const seed of seedsUsed) {
        const result = await runScenario(scenario, { thresholds, seed, listenAccuracy, ear: earOption(useEar) });
        answers += result.answers.length;
        cutIns += result.cutIns;
        talkOver += result.talkOverMsTotal;
        wasted += result.wastedVoiceChars;
        discarded += result.discarded;
        speculations += result.speculations;
        const ends = result.answers.map(answer => answer.end);
        for (const timing of result.timings) {
          // Only replies to a finished answer count: a reply to a mid-answer pause is a cut-in, not a latency.
          if (Number.isFinite(timing.lastWordToFirstSoundMs) && ends.some(end => Math.abs(end - timing.lastWordAt) < 5)) latencies.push(timing.lastWordToFirstSoundMs);
        }
      }
      const cutInRate = answers ? cutIns / answers : 0;
      return {
        ...thresholds, listenAccuracy, ear: !!useEar, answers, cutIns, discarded, speculations, samples: latencies.length,
        cutInRate, falseCutInRate: cutInRate, // falseCutInRate: legacy name read by chooseBest
        talkOverMsMean: cutIns ? round(talkOver / cutIns) : null,
        discardRate: speculations ? discarded / speculations : 0,
        wastedVoiceChars: wasted, wastedVoiceCharsPerAnswer: answers ? round(wasted / answers) : 0,
        p50Ms: round(percentile(latencies, 0.5)), p95Ms: round(percentile(latencies, 0.95)),
      };
    }
  }
}

/** Per listenAccuracy: the lowest-p95 rows with cut-in rate <= 5%, and the lowest wasted-character rows. */
export function summarizeSweep(rows, { maxCutInRate = SUMMARY_MAX_CUT_IN_RATE, top = SUMMARY_ROWS } = {}) {
  const groups = [...new Set(rows.map(row => `${row.listenAccuracy}|${row.ear ? 'on' : 'off'}`))];
  return groups.map(key => {
    const [accuracy, earLabel] = key.split('|');
    const listenAccuracy = Number(accuracy);
    const ear = earLabel === 'on';
    const own = rows.filter(row => row.listenAccuracy === listenAccuracy && !!row.ear === ear);
    const lowestP95 = own.filter(row => row.cutInRate <= maxCutInRate && row.p95Ms !== null)
      .sort((a, b) => a.p95Ms - b.p95Ms || a.cutInRate - b.cutInRate || a.commitMs - b.commitMs).slice(0, top);
    const lowestWasted = [...own]
      .sort((a, b) => a.wastedVoiceCharsPerAnswer - b.wastedVoiceCharsPerAnswer || (a.p95Ms ?? Infinity) - (b.p95Ms ?? Infinity)).slice(0, top);
    return { listenAccuracy, ear, lowestP95, lowestWasted };
  });
}

const pct = value => `${(value * 100).toFixed(1)}%`;
const ROW_HEADER = 'speculateMs commitMs voiceGate listen  cutIn/answer talkOverMs discarded wastedChars/answer  p50ms   p95ms  ear';
const rowLine = row => [String(row.speculateMs).padEnd(11), String(row.commitMs).padEnd(8), String(row.voiceGateMs).padEnd(9),
  row.listenAccuracy.toFixed(1).padEnd(6), pct(row.cutInRate).padStart(12), String(row.talkOverMsMean ?? '-').padStart(10),
  pct(row.discardRate).padStart(9), String(row.wastedVoiceCharsPerAnswer).padStart(18), String(row.p50Ms).padStart(7),
  String(row.p95Ms).padStart(7), (row.ear ? 'on' : 'off').padStart(4)].join(' ');

const earLabelOf = group => `${group.listenAccuracy.toFixed(1)} (ear ${group.ear ? 'on' : 'off'})`;

/** Per-accuracy summary rows are indented under a "#n" marker so they never read as table rows. */
function summaryLines(sweep) {
  const lines = [];
  for (const group of sweep.summary) {
    lines.push('', `listenAccuracy ${earLabelOf(group)}: lowest p95 with cut-in rate <= ${pct(SUMMARY_MAX_CUT_IN_RATE)}`);
    if (!group.lowestP95.length) lines.push('  (no row meets the cut-in limit)');
    group.lowestP95.forEach((row, index) => lines.push(`  #${index + 1} ${rowLine(row)}`));
    lines.push(`listenAccuracy ${earLabelOf(group)}: ${SUMMARY_ROWS} lowest wasted voice characters per answer`);
    group.lowestWasted.forEach((row, index) => lines.push(`  #${index + 1} ${rowLine(row)}`));
  }
  return lines;
}

/** table: also print every row (the CLI prints it only with --table; --json always has every row). */
export function formatSweep(sweep, { table = true } = {}) {
  const lines = [
    `Threshold sweep on pause-heavy answers (${sweep.scenarioLabel || 'synthetic speech text'}; seeds: ${sweep.seeds.join(',')})`,
    `Pause source: ${sweep.pauseSource ? sweep.pauseSource.line : PAUSE_SOURCE_LINE}`,
    ROW_HEADER,
  ];
  if (table) for (const row of sweep.rows) lines.push(rowLine(row));
  lines.push(...summaryLines(sweep));
  const { qualified, row } = sweep.best;
  if (!row) lines.push('No rows.');
  else if (qualified) lines.push(`Best pair: speculateMs=${row.speculateMs} commitMs=${row.commitMs} (cut-in ${pct(row.falseCutInRate)}, p95 ${row.p95Ms} ms; rule: cut-in <= 2% and p95 <= 2500 ms, lowest p95)`);
  else lines.push(`No pair meets the rule (cut-in <= 2% and p95 <= 2500 ms). Lowest cut-in pair: speculateMs=${row.speculateMs} commitMs=${row.commitMs} (cut-in ${pct(row.falseCutInRate)}, p95 ${row.p95Ms} ms)`);
  return lines.join('\n');
}

// ---- CLI --------------------------------------------------------------------
async function main(argv) {
  const flag = name => argv.includes(`--${name}`);
  const value = name => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
  const seeds = value('seeds') ? Number(value('seeds')) : 5;
  const json = flag('json');
  if (flag('sweep')) {
    const sweep = await runSweep({ seeds });
    console.log(json ? JSON.stringify(sweep, null, 2) : formatSweep(sweep, { table: flag('table') }));
    return;
  }
  const names = value('scenario') ? [value('scenario')] : SCENARIOS.map(item => item.name);
  const out = [];
  for (const name of names) {
    for (const seed of seedList(seeds)) {
      const result = await runScenario(getScenario(name), { seed });
      out.push({
        scenario: name, seed, plays: result.commands.filter(c => c.type === 'play').length,
        cancels: result.commands.filter(c => c.type === 'cancel').length, cutIns: result.cutIns, discarded: result.discarded,
        ended: result.ended ? result.ended.reason : null, incomplete: result.incomplete,
      });
    }
  }
  console.log(json ? JSON.stringify(out, null, 2) : out.map(row => Object.values(row).join('\t')).join('\n'));
}

const entry = process.argv[1] ? (await import('node:url')).pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
