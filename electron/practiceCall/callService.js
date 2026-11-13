import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { PRACTICE_AUDIO_MESSAGES } from '../interviewPracticeAudio.js';

const execFile = promisify(execFileCb);
const CALL_CHANNELS = Object.freeze({ start: 'practice-call:start', openReplay: 'practice-call:open-replay', list: 'practice-call:list' });
const PHASES = Object.freeze(['consent', 'downloading', 'precheck', 'ringing', 'connecting', 'in-call', 'ended', 'analyzing', 'replay', 'error']);
const CLASSIFIER_INSTRUCTIONS = 'You classify one candidate utterance. Reply with exactly one word: acknowledgement if it only acknowledges, agrees or fills a pause, or interruption if it starts a new thought, question or correction. No punctuation, no explanation.';
const USAGE_LIMIT_MESSAGE = 'Claude usage is limited right now; analysis may wait until the limit resets.';
const MODELS = Object.freeze(['smartTurn', 'tone']);

function practiceAudioMessage(code) {
  return PRACTICE_AUDIO_MESSAGES[code] || PRACTICE_AUDIO_MESSAGES['capture-failed'];
}

async function moduleExport(spec, names) {
  const module = await import(spec);
  for (const name of names) if (typeof module[name] === 'function') return module[name];
  if (typeof module.default === 'function') return module.default;
  throw new Error(`practice call service: ${spec} is unavailable`);
}
const lazily = factory => { let value; return () => (value ??= factory()); };
const DEFAULTS = Object.freeze({
  validateArgs: lazily(() => moduleExport('../ipc/interviewPreparation.js', ['validateInterviewPreparedBriefLoadArgs'])),
  loadBrief: lazily(() => moduleExport('../ipc/interviewPreparation.js', ['loadInterviewPreparedBrief'])),
  loadCards: lazily(() => moduleExport('../ipc/interviewQaStore.js', ['loadInterviewQaLiveCards'])),
  orderCards: lazily(() => moduleExport('../ipc/interviewQaPractice.js', ['orderPracticeQuestions'])),
  engineFactory: lazily(() => moduleExport('../interviewPracticeCallEngine.js', ['createPracticeCallEngine'])),
  helperFactory: lazily(() => moduleExport('../interviewPracticeAudio.js', ['createPracticeAudioHelper'])),
  sessionsFactory: lazily(() => moduleExport('../interviewPracticeTransport.js', ['createInterviewerSession'])),
  inference: lazily(() => moduleExport('./models/inferenceWorker.js', ['createPracticeInference'])),
  analyze: lazily(() => moduleExport('./analysis/analyzeCall.js', ['analyzeCall', 'analyze', 'createAnalyzeCall'])),
  mixdown: lazily(() => moduleExport('./audio/mixdown.js', ['mixTracks'])),
  trackFactory: lazily(() => moduleExport('./audio/trackWriter.js', ['createInterviewerTrack'])),
  earFactory: lazily(() => moduleExport('./ear.js', ['createPracticeEar'])),
  usageLimit: lazily(() => moduleExport('../ipc/claudePause.js', ['claudeUsageLimit'])),
  readKey: lazily(() => moduleExport('./eleven/elevenKey.js', ['readElevenLabsKey'])),
  subscriptionTier: lazily(() => moduleExport('./eleven/dialogueVoice.js', ['fetchSubscriptionTier'])),
  rateForTier: lazily(() => moduleExport('./eleven/dialogueVoice.js', ['rateForTier'])),
  voiceFactory: lazily(() => moduleExport('./eleven/dialogueVoice.js', ['createDialogueVoiceFactory', 'createDialogueVoice'])),
  transcribeVerbatim: lazily(() => moduleExport('./eleven/scribe.js', ['transcribeVerbatim'])),
  modelStore: lazily(() => moduleExport('./models/modelStore.js', ['createModelStore'])),
  registryStatus: lazily(async () => async () => ({ order: [] })),
  afconvert: lazily(async () => args => execFile('/usr/bin/afconvert', args)),
});
/** Whole modules, kept apart so every DEFAULTS entry resolves to a function. */
const MODULES = Object.freeze({
  prompts: lazily(() => import('../interviewPracticeCallPrompt.js')),
  catalog: lazily(() => import('./eleven/voiceCatalog.js')),
  voiceLibrary: lazily(() => import('./eleven/voiceLibrary.js')),
});

function plainArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Practice call requires a valid request.');
  return value;
}
const STEERING_MAX_CHARS = 1000;
/** The candidate's optional steering text; kept apart from the strict six-key load args. */
function steeringText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    const error = new TypeError('Practice call steering must be a string.');
    error.code = 'practice-call-args';
    throw error;
  }
  const trimmed = value.trim();
  if (trimmed.length > STEERING_MAX_CHARS) {
    const error = new TypeError(`Practice call steering must be at most ${STEERING_MAX_CHARS} characters.`);
    error.code = 'practice-call-args';
    throw error;
  }
  return trimmed;
}
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function initialsOf(name) {
  return String(name || '').trim().split(/\s+/u).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
}
function pickRandom(list, random = Math.random) {
  const value = Number(random?.());
  const at = Number.isFinite(value) ? Math.floor(Math.min(Math.max(value, 0), 0.999999) * list.length) : 0;
  return list[at];
}
/** The pool keeps one stamp per voice; the newest one is the voice to avoid on the next call. */
function mostRecentlyUsed(lastUsed) {
  let best = null;
  for (const [voiceId, at] of Object.entries(lastUsed && typeof lastUsed === 'object' ? lastUsed : {})) {
    const value = Number(at);
    if (!voiceId || !Number.isFinite(value)) continue;
    if (!best || value > best.at) best = { voiceId, at: value };
  }
  return best ? best.voiceId : null;
}
/**
 * One discarded 'Hi.' keeps an unsaved library voice fast: live tests on 2026-11-08
 * measured ~4.5 s for its first line but ~0.25 s for every line after it, even after
 * 180 s of silence. The audio is counted and thrown away, never played or transcribed.
 */
const WARM_UP_TIMEOUT_MS = 15000;
async function warmUpVoice({ factory, clock }) {
  let stream;
  try { stream = factory?.open?.({ utteranceId: 'warm-up' }); } catch { return false; }
  if (!stream) return false;
  let bytes = 0;
  let failed = false;
  const cancel = () => { try { stream.cancel?.(); } catch { /* stream already closed */ } };
  try {
    stream.onAudio?.(chunk => { bytes += chunk?.byteLength ?? chunk?.length ?? 0; });
    // Fakes may not implement onError; the optional call keeps them usable.
    stream.onError?.(() => { failed = true; });
    stream.sendText?.('Hi.');
    let timer = null;
    const finished = Promise.resolve(stream.finish?.()).then(() => true, () => false);
    const timeout = new Promise(resolveTimeout => {
      try { timer = clock.setTimeout(() => { cancel(); resolveTimeout(false); }, WARM_UP_TIMEOUT_MS); } catch { resolveTimeout(false); }
    });
    const settled = await Promise.race([finished, timeout]);
    try { if (timer !== null) clock.clearTimeout(timer); } catch { /* the timer already fired */ }
    if (!settled) return false;
  } catch {
    cancel();
    return false;
  }
  return bytes > 0 && !failed;
}
/** Interviewer titles stay generic: they never imply a discipline the job did not advertise. */
function roleFor(brief, random = Math.random) {
  const title = String(brief?.role?.title || '').trim();
  return pickRandom(['Hiring Manager', ...(title ? [`Senior ${title}`] : []), 'Team Lead'], random);
}
function teamFor(brief) {
  const role = brief?.role ?? {};
  const named = String(role.team ?? role.department ?? '').trim();
  return named || 'the hiring team';
}
/** Tough only when the request or the brief asks for it; otherwise null, and the interviewer picks one to fit its voice. */
function temperamentFor({ request, brief } = {}) {
  const asked = String(request?.temperament ?? brief?.practice?.temperament ?? brief?.temperament ?? '').trim().toLowerCase();
  return asked === 'tough' ? 'tough' : null;
}
/** The prepared brief flattened into the prompt module's brief shape. */
function promptBrief(brief) {
  const facts = value => (Array.isArray(value) ? value : []).map(item => (typeof item === 'string' ? item : item?.fact)).filter(text => typeof text === 'string' && text.trim());
  return {
    company: String(brief?.role?.company || ''), role: String(brief?.role?.title || ''),
    roleSummary: String(brief?.role?.summary || ''), roleThemes: facts(brief?.roleThemes),
    companyFacts: facts(brief?.companyFacts), recentContext: facts(brief?.recentContext),
  };
}
function freshState() {
  return {
    phase: 'precheck', callId: null, persona: null, elapsedMs: 0, muted: false, level: 0, speaking: null,
    typing: false, chat: [], captions: [], modelDownload: null, usageWarning: null, error: null,
  };
}
function errorState(code, message) {
  return { code, message: typeof message === 'string' && message ? message : 'The practice call could not continue.' };
}

/**
 * Main-process call orchestrator. Every side effect (audio, models, ElevenLabs,
 * Claude, analysis, clock) is injected; the default imports are resolved lazily
 * so tests and non-Electron hosts never load them.
 */
export function createPracticeCallService(deps = {}) {
  if (!deps.store || typeof deps.store.ensure !== 'function') throw new TypeError('Practice call service requires a call store.');
  const userDataPath = deps.userDataPath;
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('Practice call service requires the user data path.');
  const clock = deps.clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) };
  const newId = deps.newId ?? (() => `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const fs = deps.fs ?? fsPromises;
  const store = deps.store;
  let state = freshState();
  let call = null;
  let seq = 0;
  let starting = false;
  let finishing = false;
  let elapsedTimer = null;
  const stateListeners = new Set();
  const eventListeners = new Set();
  const replayListeners = new Set();
  const snapshot = () => ({ ...state, chat: state.chat.map(item => ({ ...item })), captions: state.captions.map(item => ({ ...item })) });
  const publish = () => { const next = snapshot(); for (const listener of stateListeners) { try { listener(next); } catch { /* listeners stay isolated */ } } };
  const emitEvent = event => {
    const payload = event && typeof event === 'object' && event.kind === undefined && typeof event.type === 'string'
      ? { ...event, kind: event.type } : event;
    for (const listener of eventListeners) { try { listener(payload); } catch { /* listeners stay isolated */ } }
  };
  const emitReplay = replay => { for (const listener of replayListeners) { try { listener(replay); } catch { /* listeners stay isolated */ } } };
  const setPhase = phase => {
    if (!PHASES.includes(phase)) return;
    state.phase = phase;
    if (phase === 'ended' || phase === 'analyzing' || phase === 'replay' || phase === 'error') state.speaking = null;
    publish();
  };
  function stopElapsedTimer() {
    if (elapsedTimer === null) return;
    try { clock.clearTimeout(elapsedTimer); } catch { /* already cleared */ }
    elapsedTimer = null;
  }
  function startElapsedTimer() {
    stopElapsedTimer();
    const tick = () => {
      elapsedTimer = null;
      if (!call || call.finished) return;
      state.elapsedMs = Math.max(0, Math.round(clock.now() - call.startedAt));
      publish();
      elapsedTimer = clock.setTimeout(tick, 1000);
    };
    elapsedTimer = clock.setTimeout(tick, 1000);
  }
  const fail = (code, cause) => {
    const message = cause?.userMessage || (code === 'voice-key-missing' ? 'The ElevenLabs key is not available on this computer.' : cause?.message);
    const failed = call;
    call = null;
    starting = false;
    stopElapsedTimer();
    state.modelDownload = null;
    if (failed) { failed.finished = true; cleanupCall(failed).catch(() => {}); }
    state.error = errorState(code, message);
    setPhase('error');
    return snapshot();
  };
  const alreadyRunning = () => ({
    ...snapshot(), phase: 'error', error: { code: 'already-running', message: 'A practice call is already running.' },
  });

  async function resolve(name) {
    if (deps[name] !== undefined && deps[name] !== null) return deps[name];
    const factory = DEFAULTS[name] ?? MODULES[name];
    if (typeof factory !== 'function') throw new Error(`practice call service: ${name} is unavailable`);
    return factory();
  }

  async function loadPlan(args) {
    const validate = await resolve('validateArgs');
    validate(args);
    const loadBrief = await resolve('loadBrief');
    const brief = await loadBrief({ briefRecordId: args.briefRecordId, userDataPath });
    if (!brief || brief.inputs?.careerSnapshotId !== args.snapshotId
      || brief.inputs?.jobUrlSha256 !== sha256(args.canonicalJobUrl)
      || brief.inputs?.applicationArtifactId !== args.bundleArtifactId
      || brief.inputs?.applicationArtifactDigest !== args.bundleArtifactDigest) throw new Error('Prepare this interview before practicing.');
    const loadCards = await resolve('loadCards');
    const orderCards = await resolve('orderCards');
    const registryStatus = await resolve('registryStatus');
    const [cards, saved] = await Promise.all([loadCards({ userDataPath, nodeId: args.nodeId }), Promise.resolve(registryStatus(args.nodeId))]);
    const ordered = orderCards(cards, saved?.order);
    if (!ordered.length) throw new Error('No prepared questions yet. Run Prepare on this Interview Helper first.');
    return { brief, plan: ordered.map(card => ({ id: card.id, question: card.question, answer: card.answer })) };
  }

  async function modelStatus(modelStore) { return modelStore.status(); }
  async function downloadModels() {
    const self = call;
    if (!self || self.finished) return snapshot();
    const modelStore = self.modelStore;
    self.downloadAbort = new AbortController();
    setPhase('downloading');
    try {
      for (const name of MODELS) {
        if ((await modelStatus(modelStore))[name] === 'ready') continue;
        state.modelDownload = { receivedBytes: 0, totalBytes: 0, sizes: self.modelSizes ?? null };
        publish();
        await modelStore.ensure(name, {
          signal: self.downloadAbort.signal,
          onProgress: progress => {
            state.modelDownload = { receivedBytes: Number(progress?.receivedBytes) || 0, totalBytes: Number(progress?.totalBytes) || 0 };
            publish();
          },
        });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || call !== self || self.finished) return snapshot();
      return fail('model-download-failed', error);
    }
    if (call !== self || self.finished) return snapshot();
    state.modelDownload = null;
    return prepare();
  }

  function closeEar(self) {
    try { self.ear?.close?.(); } catch { /* ear is best effort */ }
  }

  async function closeWarmSessions(self) {
    const sessions = self.sessions ? Object.values(self.sessions) : [];
    await Promise.all(sessions.map(session => {
      try {
        const closed = session?.close?.() ?? session?.cancel?.() ?? session?.stop?.();
        return Promise.resolve(closed).catch(() => {});
      } catch { return Promise.resolve(); }
    }));
  }

  /** R12: let in-flight tone work settle (bounded) before the tone samples are snapshotted. */
  async function settleNotes(self) {
    try { await self.ear?.settle?.(2000); } catch { /* bounded wait */ }
  }

  /** R3: stop every owner a failed or abandoned call may still hold. */
  async function cleanupCall(self) {
    self.finished = true;
    stopElapsedTimer();
    closeEar(self);
    try { self.downloadAbort?.abort?.(); } catch { /* already aborted */ }
    try { self.audioMirror?.stop?.(); } catch { /* audio mirror already stopped */ }
    try { await self.helper?.stop?.(); } catch { /* audio owner already stopped */ }
    await closeWarmSessions(self);
  }

  function createMirror(helper, track) {
    const chunks = new Map();
    const rates = new Map();
    const safe = (fn, ...args) => { try { return fn?.(...args); } catch { return undefined; } };
    // R1: the track writer throws 'unknown utterance' unless the id is registered first.
    const register = (id, pcm, sampleRate) => safe(() => track?.addUtterance?.(id, pcm, sampleRate));
    const free = id => { chunks.delete(id); rates.delete(id); };
    return {
      start: options => helper.start?.(options),
      play(id, sampleRate) {
        const result = helper.play?.(id, sampleRate);
        const rate = sampleRate || rates.get(id) || 24000;
        rates.set(id, rate);
        chunks.set(id, chunks.get(id) || []);
        register(id, Buffer.alloc(0), rate);
        safe(() => track?.started?.(id, 0));
        return result;
      },
      pushAudio(id, pcm, sampleRate) {
        const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm?.buffer ?? pcm, pcm?.byteOffset ?? 0, pcm?.byteLength ?? 0);
        const list = chunks.get(id) || [];
        list.push(Buffer.from(buffer));
        chunks.set(id, list);
        const rate = sampleRate || rates.get(id) || 24000;
        rates.set(id, rate);
        // R1: keep the writer's duration current so pause/ended positions are valid.
        register(id, Buffer.concat(list), rate);
        return helper.pushAudio?.(id, pcm, sampleRate);
      },
      endUtterance(id) {
        register(id, Buffer.concat(chunks.get(id) || []), rates.get(id) || 24000);
        free(id);
        return helper.endUtterance?.(id);
      },
      cancel(id) { free(id); return helper.cancel?.(id); },
      pause(id) { return helper.pause?.(id); },
      resume(id) { return helper.resume?.(id); },
      mute(muted) { return helper.mute?.(muted); },
      stop() { return helper.stop?.(); },
      // R2: the helper forwards `utteranceId`; track timing follows the helper clock, not ours.
      helperEvent(event) {
        if (event?.type !== 'playback') return;
        const id = event.utteranceId;
        if (!id) return;
        const atMs = Number.isFinite(event.atMs) ? event.atMs : 0;
        const positionMs = Number.isFinite(event.positionMs) ? event.positionMs : 0;
        if (event.state === 'started') safe(() => track?.started?.(id, atMs));
        else if (event.state === 'paused') safe(() => track?.paused?.(id, positionMs, atMs));
        else if (event.state === 'resumed') safe(() => track?.resumed?.(id, atMs));
        else if (event.state === 'finished' || event.state === 'cancelled') safe(() => track?.ended?.(id, positionMs, atMs));
      },
    };
  }

  function onHelperEvent(event) {
    const self = call;
    if (!self) return;
    try { self.audioMirror?.helperEvent(event); } catch { /* track writer is best effort */ }
    if (event?.type === 'level') { state.level = Math.max(0, Math.min(1, Number(event.rms) || 0)); publish(); }
    if (event?.type === 'vad') {
      state.speaking = event.speaking ? 'candidate' : null;
      publish();
    }
    if (event?.type === 'transcript' && event.final && Number.isFinite(event.startMs) && Number.isFinite(event.endMs)) {
      self.timings.answers.push({ startMs: event.startMs, endMs: event.endMs });
      try {
        const work = Promise.resolve(self.ear?.noteSpeech({ startMs: event.startMs, endMs: event.endMs })).catch(() => {});
        (self.noteWork ||= new Set()).add(work);
        work.finally(() => self.noteWork?.delete(work));
      } catch { /* tone is best effort */ }
    }
    if (event?.type === 'recording' && event.state === 'closed') self.recordingClosed?.();
    if (event?.type === 'error') {
      self.engine?.helperEvent?.(event);
      finishCall('helper-error').catch(() => {});
      return;
    }
    self.engine?.helperEvent?.(event);
  }

  /**
   * The practice voice pool lives beside the call records and holds one thing: when each
   * voice was last used. A missing, corrupt or unwritable file is never a reason to fail
   * a call: every error becomes null.
   */
  async function openVoicePool() {
    try {
      const library = await resolve('voiceLibrary');
      if (!library || typeof library.createVoicePoolStore !== 'function') return null;
      // The pool file is the service's own bookkeeping, so it never goes through the
      // call-recording file system the tests (and the journal) watch.
      const store = library.createVoicePoolStore({ filePath: path.join(userDataPath, 'practice-voice-pool.json') });
      let loaded = null;
      try {
        loaded = await store.load();
      } catch { /* an unreadable pool file reads as an empty pool */ }
      const loadedState = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
      const state = {
        version: 1,
        lastUsed: loadedState.lastUsed && typeof loadedState.lastUsed === 'object' ? { ...loadedState.lastUsed } : {},
      };
      return { library, store, state };
    } catch {
      return null;
    }
  }

  async function precheck() {
    const self = call;
    if (!self || self.finished) return snapshot();
    setPhase('precheck');
    const usageLimit = await resolve('usageLimit');
    call.usageLimit = await usageLimit();
    state.usageWarning = call.usageLimit ? USAGE_LIMIT_MESSAGE : null;
    publish();
    const readKey = await resolve('readKey');
    const key = await readKey();
    if (call !== self || self.finished) return snapshot();
    if (typeof key !== 'string' || !key) throw new Error('No ElevenLabs key.');
    call.key = key;
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const fetchTier = await resolve('subscriptionTier');
    let tier = 'free';
    try {
      const reported = await fetchTier({ fetch: fetchImpl, key });
      if (typeof reported === 'string' && reported) tier = reported;
    } catch { /* account rate falls back to the free tier */ }
    const rateForTier = await resolve('rateForTier');
    const voiceRate = Number(rateForTier(tier)) || 24000;
    const catalog = await resolve('catalog');
    // The pool file only names the voices used before; it never grows, because the app
    // never writes to the ElevenLabs account.
    const pool = await openVoicePool();
    const recentVoiceId = mostRecentlyUsed(pool?.state.lastUsed);
    const prompts = await resolve('prompts');
    const random = deps.random ?? Math.random;
    const temperament = temperamentFor({ request: call.args, brief: call.brief });
    const voiceFactory = await resolve('voiceFactory');
    const personaOf = (chosen, voiceSource) => {
      const picked = !chosen?.name && typeof prompts.pickPersona === 'function' ? prompts.pickPersona({ random, temperament: temperament ?? 'neutral' }) : null;
      return {
        name: chosen?.name || picked?.name || 'Alex Morgan', role: roleFor(call.brief, random), team: teamFor(call.brief),
        temperament, temperamentFrom: temperament ? 'request' : null,
        voice: chosen ? { gender: chosen.gender, age: chosen.age, accent: chosen.accent, character: chosen.character } : null,
        voiceId: chosen?.voiceId, voiceSource, initials: initialsOf(chosen?.name || picked?.name),
      };
    };
    // The interviewer voice comes only from the shared library: the account's own voices
    // are never candidates and nothing here falls back to them.
    let drawn = null;
    try {
      if (pool?.library && typeof pool.library.drawVoice === 'function') {
        drawn = await pool.library.drawVoice({
          fetch: fetchImpl, key, random,
          excludeVoiceIds: recentVoiceId ? [recentVoiceId] : [],
        });
      }
    } catch { drawn = null; }
    let chosen = null;
    if (drawn?.voice) {
      try { chosen = catalog.pickPersonaVoice({ voices: [drawn.voice], random, temperament }); } catch { chosen = null; }
      // A drawn voice with no usable id cannot speak, and there is no second choice.
      if (!chosen?.voiceId) chosen = null;
    }
    if (call !== self || self.finished) return snapshot();
    if (!chosen) {
      return fail('voice-library-unavailable', {
        userMessage: 'Could not load an interviewer voice from the ElevenLabs voice library. Check your internet connection and try again.',
      });
    }
    const persona = personaOf(chosen, 'library');
    const factory = voiceFactory({ key, voiceId: persona.voiceId, tier });
    // Warm the unsaved library voice up before the call can ring, so its first real line
    // is not the slow one. A voice that does not answer is a failed call, not a second pick.
    const warmed = await warmUpVoice({ factory, clock });
    if (call !== self || self.finished) return snapshot();
    if (!warmed) {
      return fail('voice-warmup-failed', {
        userMessage: 'The interviewer voice did not respond. Try starting the call again.',
      });
    }
    call.promptBrief = promptBrief(call.brief);
    call.persona = persona;
    state.persona = { name: persona.name, initials: persona.initials, role: persona.role, team: persona.team };
    // call.voice is always the factory of the voice actually used.
    call.voice = factory;
    if (pool && persona.voiceId) {
      // A stale pool file must never cost the call its voice.
      pool.state.lastUsed[persona.voiceId] = clock.now();
      try { await pool.store.save(pool.state); } catch { /* a stale pool file must never cost the call */ }
    }
    const helperFactory = await resolve('helperFactory');
    const trackFactory = await resolve('trackFactory');
    call.voiceRate = voiceRate;
    call.track = trackFactory({ sampleRate: voiceRate });
    call.audioMirror = createMirror(null, call.track);
    const helper = helperFactory({ onEvent: onHelperEvent });
    call.helper = helper;
    call.audioMirror = createMirror(helper, call.track);
    const candidatePath = path.join(call.dir, 'candidate.wav');
    call.candidatePath = candidatePath;
    call.recordingClosed = null;
    const closed = new Promise(resolveClosed => { call.recordingClosed = resolveClosed; });
    call.recordingClosedPromise = closed;
    const started = await helper.start({ recordingPath: candidatePath });
    // R4: a refused helper start is a failed call, not a silent one.
    if (started && started.ok === false) {
      const code = typeof started.code === 'string' && started.code ? started.code : 'capture-failed';
      return fail(code, { userMessage: practiceAudioMessage(code) });
    }
    if (call !== self || self.finished) return snapshot();
    const earFactory = await resolve('earFactory');
    // The worker entry is built as its own bundle entry, so only the service
    // knows its built path: hand the ear a factory that names it.
    const inference = async ({ smartTurnPath, tonePath }) => {
      const createInference = await resolve('inference');
      return createInference({ smartTurnPath, tonePath, workerPath: deps.inferenceWorkerPath });
    };
    call.ear = earFactory({
      candidatePath, smartTurnPath: call.modelStore.pathOf('smartTurn'), tonePath: call.modelStore.pathOf('tone'),
      inference,
      onToneSample: sample => { call.toneSamples.push(sample); },
    });
    await createSessions();
    if (call !== self || self.finished) return snapshot();
    call.timings.precheckMs = Math.round(clock.now() - call.startedAt);
    setPhase('ringing');
    return snapshot();
  }

  async function createSessions() {
    const sessionsFactory = await resolve('sessionsFactory');
    const prompts = await resolve('prompts');
    const create = () => sessionsFactory({ model: 'opus', effort: 'low' });
    const opener = create();
    const main = create();
    const classifier = create();
    const targetMinutes = deps.targetMinutes ?? [25, 30];
    const optionsFor = temperament => ({
      persona: {
        name: call.persona.name, role: call.persona.role, team: call.persona.team, temperament, voice: call.persona.voice,
      },
      brief: call.promptBrief, plan: call.plan, targetMinutes, steering: call.steering,
    });
    const settle = temperament => {
      const options = optionsFor(temperament);
      call.instructions = { opener: prompts.buildOpenerInstructions(options), main: prompts.buildInterviewerInstructions(options) };
    };
    if (call.persona.temperament) {
      settle(call.persona.temperament);
      await Promise.all([
        opener.start({ instructions: call.instructions.opener }),
        main.start({ instructions: call.instructions.main }),
        classifier.start({ instructions: CLASSIFIER_INSTRUCTIONS }),
      ]);
    } else {
      // The main session picks the temperament that fits its voice; the opener then
      // starts with that same temperament so the short reactions match the replies.
      const classifierReady = Promise.resolve(classifier.start({ instructions: CLASSIFIER_INSTRUCTIONS }));
      classifierReady.catch(() => {}); // still awaited below; this only covers a main-session failure first
      const ready = await main.start({ instructions: prompts.buildInterviewerInstructions(optionsFor(null)) });
      const picked = typeof prompts.temperamentFromReady === 'function' ? prompts.temperamentFromReady(ready?.reply) : null;
      call.persona.temperament = picked || 'neutral';
      call.persona.temperamentFrom = picked ? 'claude' : 'fallback';
      // A restarted main session gets the settled temperament, not a fresh choice.
      settle(call.persona.temperament);
      await Promise.all([opener.start({ instructions: call.instructions.opener }), classifierReady]);
    }
    call.sessions = { opener, main, classifier };
    call.restartSession = async (kind, { transcriptText } = {}) => {
      const next = create();
      const base = kind === 'opener' ? call.instructions.opener : kind === 'classifier' ? CLASSIFIER_INSTRUCTIONS : call.instructions.main;
      const earlier = typeof transcriptText === 'string' ? transcriptText.trim() : '';
      await next.start({ instructions: earlier ? `${base}\n\nEarlier in this call:\n${earlier}` : base });
      call.sessions = { ...call.sessions, [kind]: next };
      return call.sessions;
    };
    return call.sessions;
  }

  function onEngineEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'phase') {
      if (event.phase === 'speaking') state.speaking = 'interviewer';
      else if (event.phase === 'listening') state.speaking = null;
      publish();
      return;
    }
    if (event.type === 'caption') {
      state.captions.push({ speaker: event.speaker, text: event.text, final: !!event.final });
      state.captions = state.captions.slice(-6);
      publish();
      emitEvent({ type: 'caption', ...event });
      return;
    }
    if (event.type === 'chat') {
      state.chat.push({ from: event.from || 'interviewer', text: String(event.text ?? ''), atMs: Math.round(clock.now() - (call?.startedAt || clock.now())) });
      publish();
      emitEvent({ type: 'chat', ...event });
      return;
    }
    if (event.type === 'ended') { finishCall(event.reason || 'ended').catch(() => {}); return; }
    emitEvent(event);
  }

  /** R8: a call that never reached 'in-call' is torn down without a record, mix or analysis. */
  async function abandonCall(self) {
    stopElapsedTimer();
    try { self.engine?.hangUp?.(); } catch { /* engine already stopping */ }
    try { await self.helper?.stop?.(); } catch { /* audio owner already stopped */ }
    closeEar(self);
    try { self.downloadAbort?.abort?.(); } catch { /* already aborted */ }
    await closeWarmSessions(self);
    state.modelDownload = null;
    state.elapsedMs = Math.max(0, Math.round(clock.now() - self.startedAt));
    try { await store.remove?.(self.callId); } catch { /* nothing to delete */ }
    setPhase('replay');
    const replay = await getReplay(self.callId).catch(() => null);
    if (call === self) call = null;
    emitReplay(replay);
    return snapshot();
  }

  async function finishCall(reason = 'candidate') {
    if (!call || call.finished) return snapshot();
    const self = call;
    // R7: everything below reads `self`, never the shared `call` handle.
    self.finished = true;
    finishing = true;
    stopElapsedTimer();
    try {
      if (!self.inCall) return await abandonCall(self);
      const engineState = self.engine?.state?.() || { transcript: [], elapsedMs: Math.round(clock.now() - self.startedAt) };
      try { self.engine?.hangUp?.(); } catch { /* timers are already stopping */ }
      state.elapsedMs = engineState.elapsedMs || Math.round(clock.now() - self.startedAt);
      setPhase('ended');
      try { await self.helper?.stop?.(); } catch { /* audio owner already stopped */ }
      try { await Promise.race([self.recordingClosedPromise, new Promise(resolveWait => clock.setTimeout(resolveWait, 5000))]); } catch { /* bounded wait */ }
      await settleNotes(self);
      const durationMs = Math.max(0, Math.round(clock.now() - self.startedAt));
      const interviewerPath = path.join(self.dir, 'interviewer.wav');
      let finalizeError = null;
      try { await self.track.finalize(interviewerPath, { durationMs, fs }); } catch (error) { finalizeError = error; }
      closeEar(self);
      const record = {
        callId: self.callId, nodeId: self.args.nodeId, startedAt: self.startedAt, endedAt: Date.now(), durationMs,
        persona: self.persona ? { ...self.persona } : null, steering: self.steering || null, transcript: engineState.transcript || [],
        timings: { ...self.timings, finalizeMs: Math.round(clock.now() - self.startedAt - durationMs) },
        toneNotes: self.toneSamples.slice(), thresholds: deps.thresholds ?? null, reason,
      };
      self.record = record;
      await store.writeRecord(self.callId, record);
      setPhase('analyzing');
      let audio = false;
      try {
        if (finalizeError) throw finalizeError;
        const mixdown = await resolve('mixdown');
        const mixedPath = path.join(self.dir, 'call.wav');
        const mixed = await mixdown({ candidatePath: self.candidatePath, interviewerPath, outPath: mixedPath, fs });
        record.durationMs = Number(mixed?.durationMs) || durationMs;
        const outPath = path.join(self.dir, 'call.m4a');
        const afconvert = await resolve('afconvert');
        await afconvert(['-f', 'm4af', '-d', 'aac', '-b', '64000', mixedPath, outPath]);
        await fs.unlink(mixedPath).catch(() => {});
        const produced = await fs.lstat(outPath).catch(() => null);
        audio = !!produced && produced.isFile() && !produced.isSymbolicLink();
        await store.writeRecord(self.callId, record);
      } catch {
        state.error = errorState('recording-failed', 'The call recording could not be finished.');
      }
      let analysis = { status: 'failed', error: 'analysis unavailable' };
      let feedback = null;
      let analysisWritten = false;
      try {
        const analyze = await resolve('analyze');
        const transcribe = async request => {
          const extra = request && typeof request === 'object' ? request : {};
          const filePath = typeof request === 'string' ? request : extra.path;
          const options = { ...extra, path: filePath, key: self.key };
          if (typeof deps.transcribe === 'function') return deps.transcribe(options);
          const transcribeVerbatim = await resolve('transcribeVerbatim');
          return transcribeVerbatim(options);
        };
        const produced = await analyze({
          callDir: self.dir, callRecord: record, plan: self.plan, brief: self.brief,
          deps: { ...(typeof deps.callText === 'function' ? { callText: deps.callText } : {}), transcribe },
        });
        const report = produced?.analysis && typeof produced.analysis === 'object' ? produced.analysis : produced;
        const raw = produced?.feedback ?? (report && typeof report === 'object' ? report.feedback : null);
        feedback = raw && typeof raw === 'object' ? { ...raw, callId: raw.callId || self.callId } : null;
        analysis = report && typeof report === 'object'
          ? { ...report, ...(feedback ? { feedback } : {}), status: report.status === 'failed' ? 'failed' : 'ready' }
          : { status: 'failed', error: 'The call review could not be written.' };
      } catch {
        analysis = { status: 'failed', error: 'The call review could not be written.' };
        state.error = errorState('analysis-failed', analysis.error);
      }
      const stored = { callId: self.callId, createdAt: Date.now(), ...analysis };
      try { await store.writeAnalysis(self.callId, stored); analysisWritten = true; } catch { /* record still replays */ }
      self.analysis = stored;
      if (feedback) {
        try {
          const registry = deps.registry;
          if (registry && typeof registry.arm === 'function' && typeof registry.finish === 'function') {
            const armRequest = {
              nodeId: self.args?.nodeId ?? null, company: String(self.brief?.role?.company || ''),
              role: String(self.brief?.role?.title || ''), questionCount: Array.isArray(self.plan) ? self.plan.length : 0,
            };
            const arm = async () => {
              try {
                const code = await registry.arm(armRequest);
                return typeof code === 'string' && code ? code : null;
              } catch (error) {
                if (error?.code !== 'already_armed') throw error;
                return null;
              }
            };
            let code = await arm();
            if (!code) {
              if (typeof registry.cancel === 'function') await registry.cancel(armRequest.nodeId);
              code = await arm();
            }
            if (!code) throw new Error('the practice registry did not arm a session');
            await registry.finish(code, feedback);
          }
        } catch { emitEvent({ type: 'feedback-error', message: 'The practice history could not be updated.' }); }
      }
      // R9: keep the WAV sources only when the mixdown exists and the review was stored.
      if (audio && analysisWritten) {
        for (const name of ['candidate.wav', 'interviewer.wav']) {
          const file = path.join(self.dir, name);
          try {
            const entry = await fs.lstat(file);
            if (entry.isFile() && !entry.isSymbolicLink()) await fs.unlink(file);
          } catch { /* already gone */ }
        }
      }
      setPhase('replay');
      const replay = await getReplay(self.callId).catch(() => null);
      if (call === self) call = null;
      emitReplay(replay);
      return snapshot();
    } finally {
      finishing = false;
    }
  }

  async function getReplay(callId = state.callId) {
    if (typeof callId !== 'string' || !callId) return null;
    const record = call?.callId === callId ? call.record || null : await store.readRecord(callId);
    if (!record) return null;
    const analysis = call?.callId === callId && call.analysis ? call.analysis : await store.readAnalysis(callId);
    const hasAudio = await store.hasAudio(callId);
    const status = analysis?.status === 'ready' || analysis?.status === 'failed' ? analysis.status : 'missing';
    return {
      callId,
      audioUrl: hasAudio ? `practice-call://${callId}/call.m4a` : null,
      durationMs: Number(record.durationMs) || 0,
      transcript: record.transcript || [],
      chapters: Array.isArray(analysis?.chapters) ? analysis.chapters : [],
      feedback: analysis?.feedback ?? null,
      analysis: { status, ...(analysis?.error ? { error: analysis.error } : {}) },
    };
  }

  async function start(args) {
    // R5: the guard is synchronous, so a second start never touches the store.
    if (starting || finishing || (call && !call.finished)) return alreadyRunning();
    starting = true;
    try {
      state = freshState();
      call = null;
      const { steering: rawSteering, ...request } = plainArgs(args);
      const callId = newId();
      const dir = await store.ensure(callId);
      const self = { callId, dir, args: { ...request }, steering: '', startedAt: Date.now(), timings: { answers: [], precheckMs: 0 }, toneSamples: [], finished: false, inCall: false, record: null };
      call = self;
      state.callId = callId;
      state.elapsedMs = 0;
      try {
        self.steering = steeringText(rawSteering);
        const loaded = await loadPlan(request);
        if (call !== self) return snapshot();
        self.brief = loaded.brief;
        self.plan = loaded.plan;
        const modelStore = (deps.modelStore ?? await DEFAULTS.modelStore())({ rootDir: path.join(userDataPath, 'practice-models'), fetch: deps.fetch, fs, unzip: deps.unzip });
        self.modelStore = modelStore;
        const status = await modelStatus(modelStore);
        if (call !== self) return snapshot();
        const needs = MODELS.some(name => status[name] !== 'ready');
        self.modelSizes = status.sizes ?? null;
        if (needs) {
          state.modelDownload = { receivedBytes: 0, totalBytes: 0, sizes: self.modelSizes };
          setPhase('consent');
          return snapshot();
        }
        return await prepare();
      } catch (error) {
        return fail(error?.code === 'practice-call-args' ? 'invalid-request' : 'start-failed', error);
      }
    } finally {
      starting = false;
    }
  }

  async function prepare() {
    if (!call || call.finished) return snapshot();
    try { return await precheck(); } catch (error) { return fail('precheck-failed', error); }
  }

  return Object.freeze({
    channels: CALL_CHANNELS,
    start,
    agreeModelDownload: async () => {
      if (!call || state.phase !== 'consent') return snapshot();
      return downloadModels();
    },
    answer: async () => {
      if (!call || call.engine || (state.phase !== 'ringing' && state.phase !== 'connecting')) return snapshot();
      const self = call;
      setPhase('connecting');
      try {
        const engineFactory = await resolve('engineFactory');
        if (call !== self || self.finished) return snapshot();
        self.engine = engineFactory({
          clock, sessions: self.sessions, restartSession: self.restartSession, audio: self.audioMirror,
          voice: self.voice, ear: self.ear, onEvent: onEngineEvent, newId,
          ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
        });
        self.engine.start();
        self.inCall = true;
        setPhase('in-call');
        // R11: the elapsed clock is published once a second while the call runs.
        startElapsedTimer();
      } catch (error) { fail('engine-failed', error); }
      return snapshot();
    },
    hangUp: async () => finishCall('candidate'),
    abandon: async () => (call && !call.finished ? finishCall('window-closed') : snapshot()),
    setMuted: muted => {
      state.muted = !!muted;
      try { call?.audioMirror?.mute(!!muted); } catch { /* mute is best effort */ }
      publish();
      return snapshot();
    },
    sendChat: text => {
      const value = typeof text === 'string' ? text.trim() : '';
      if (!value || value.length > 2000) throw new TypeError('sendChat expects 1-2000 characters');
      state.chat.push({ from: 'candidate', text: value, atMs: Math.round(clock.now() - (call?.startedAt || clock.now())) });
      try { call?.engine?.typed?.(value); } catch { /* engine already ended */ }
      publish();
      return snapshot();
    },
    setTyping: typing => {
      state.typing = !!typing;
      try { call?.engine?.typing?.(!!typing); } catch { /* engine already ended */ }
      publish();
      return snapshot();
    },
    getState: () => snapshot(),
    getPreparedCards: () => (call?.plan || []).map(card => ({ ...card })),
    getReplay,
    deleteRecording: async callId => {
      const target = typeof callId === 'string' && callId ? callId : state.callId;
      if (!target) return null;
      // R9: a live call's recording is never deleted underneath the call.
      if (call && !call.finished && call.callId === target) return null;
      const result = await store.deleteRecording(target);
      const replay = await getReplay(target).catch(() => null);
      emitReplay(replay);
      return result;
    },
    list: nodeId => store.list(nodeId),
    onState(listener) {
      if (typeof listener !== 'function') throw new TypeError('onState expects a function');
      const token = ++seq;
      stateListeners.add(listener);
      return () => { if (stateListeners.size && seq >= token) stateListeners.delete(listener); };
    },
    onEvent(listener) {
      if (typeof listener !== 'function') throw new TypeError('onEvent expects a function');
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onReplayUpdated(listener) {
      if (typeof listener !== 'function') throw new TypeError('onReplayUpdated expects a function');
      replayListeners.add(listener);
      return () => replayListeners.delete(listener);
    },
  });
}

export { CALL_CHANNELS, CLASSIFIER_INSTRUCTIONS, DEFAULTS, MODULES };
export const createCallService = createPracticeCallService;
export default createPracticeCallService;
