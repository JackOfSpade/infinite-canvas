import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCallStore } from '../../electron/practiceCall/callStore.js';
import { createVoicePoolStore, drawVoice } from '../../electron/practiceCall/eleven/voiceLibrary.js';
import { createPracticeCallService } from '../../electron/practiceCall/callService.js';
import { createPanelVoiceFactory } from '../../electron/practiceCall/eleven/panelVoice.js';
import { createReplayHandler } from '../../electron/practiceCall/replayProtocol.js';
import { capCareerDocumentText, loadCareerDocumentText } from '../../electron/practiceCall/careerDocumentText.js';

const cases = [];
const test = (name, run) => cases.push({ name: `practice call service: ${name}`, run });
const ARGS = Object.freeze({
  nodeId: 'node-1', briefRecordId: 'b'.repeat(64), snapshotId: 'snapshot-1',
  canonicalJobUrl: 'https://example.com/jobs/1', bundleArtifactId: 'bundle-1', bundleArtifactDigest: 'd'.repeat(64),
});
const BRIEF = Object.freeze({
  version: 1, inputs: {
    careerSnapshotId: ARGS.snapshotId, jobUrlSha256: '4e5625e0ef4c1d4c7a1d0f1d3f8b9b1e7d1c9a2b3c4d5e6f7a8b9c0d1e2f3a4b',
    applicationArtifactId: ARGS.bundleArtifactId, applicationArtifactDigest: ARGS.bundleArtifactDigest,
  }, role: { title: 'Engineer', company: 'Acme' },
});
const CARD = Object.freeze({ id: 'q1', question: 'Tell me about a launch.', answer: 'I led one.' });

function fakeFs() {
  const written = [];
  return {
    written,
    async mkdir() {}, async chmod() {},
    async writeFile(file, data) { written.push({ op: 'write', file, data }); },
    async unlink(file) { written.push({ op: 'unlink', file }); },
    async lstat() { return { isFile: () => true, isSymbolicLink: () => false }; },
    async open() { return { stat: async () => ({ isFile: () => true }), readFile: async () => '{}', close: async () => {} }; },
  };
}

function memoryHistory(initial = {}) {
  const jobs = { ...initial };
  const recorded = [];
  return {
    jobs, recorded,
    async counts(nodeId) { return { ...(jobs[nodeId] || {}) }; },
    async record(nodeId, ids) { recorded.push({ nodeId, ids: [...ids] }); jobs[nodeId] = { ...(jobs[nodeId] || {}) }; for (const id of ids) jobs[nodeId][id] = (jobs[nodeId][id] || 0) + 1; },
  };
}

/** A valid plan for a solo call led by the first drawn voice, with `change` merged over it. */
function soloPlan(voices, change = {}) {
  return {
    interviewKind: 'A short screening conversation.',
    lead: { voice: voices[0].key, role: 'Hiring Manager', temperament: 'neutral', stability: 0.3, room: 0.5, manner: 'Even and direct.' },
    panel: [],
    questions: [{ number: 1, askedBy: voices[0].key, minutes: 10, probes: [] }],
    problems: [],
    ...change,
  };
}
/** The planner stand-in: every call is recorded and answered with a solo plan unless a test supplies its own. */
function fakePlanner(make = voices => soloPlan(voices)) {
  const calls = [];
  const planCall = async input => {
    calls.push(input);
    return { plan: make(input.voices, input), attempts: [], ms: 7 };
  };
  planCall.calls = calls;
  return planCall;
}

function makeDeps(overrides = {}) {
  const events = [];
  const tmp = overrides.tmp;
  const store = createCallStore({ rootDir: path.join(tmp, 'practice-calls'), ...(overrides.storeFs ? { fs: overrides.storeFs } : {}) });
  const engineEvents = [];
  let engineListener;
  const sessions = { opener: { start: async () => {} }, main: { start: async () => {} }, classifier: { start: async () => {} } };
  const deps = {
    store, userDataPath: tmp, fs: fakeFs(),
    newId: () => 'call-1',
    clock: { now: () => 1000, setTimeout: () => 1, clearTimeout: () => {} },
    validateArgs: () => {},
    loadBrief: async () => ({ ...BRIEF, inputs: { ...BRIEF.inputs, jobUrlSha256: (await import('node:crypto')).createHash('sha256').update(ARGS.canonicalJobUrl).digest('hex') } }),
    loadCards: async () => [CARD],
    loadCandidateName: async () => '',
    loadApplication: async () => ({ resume: 'Synthetic resume text.', coverLetter: 'Synthetic cover letter text.' }),
    orderCards: cards => cards,
    registryStatus: async () => ({ order: [] }),
    // In memory: no test touches the real question history file.
    questionHistory: memoryHistory(),
    modelStore: () => ({
      status: () => ({ smartTurn: overrides.modelReady ? 'ready' : 'missing', tone: overrides.modelReady ? 'ready' : 'missing' }),
      ensure: async name => { events.push(`ensure:${name}`); },
      pathOf: name => path.join(tmp, 'practice-models', `${name}.onnx`),
    }),
    readKey: async () => 'key-should-never-be-logged',
    fetch: async () => ({ ok: true, json: async () => ({ tier: 'paid' }) }),
    catalog: {
      listConversationalVoices: async () => [{ voiceId: 'v1', name: 'Ada Lovelace' }],
      pickPersonaVoice: () => ({ voiceId: 'v1', name: 'Ada Lovelace' }),
    },
    // No network and no growth: the draw is a no-op that hands back the account's voice.
    voiceLibrary: {
      createVoicePoolStore: () => ({ load: async () => ({ version: 1, lastUsed: {} }), save: async () => {} }),
      drawVoice: async () => ({ voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 1 }),
    },
    // Only the warm-up stream carries audio, so every start warms up and rings.
    voiceFactory: () => ({
      open: options => {
        const stream = {
          sampleRate: 24000, onAudio(listener) { stream.audioListener = listener; }, onWords() {},
          sendText() {}, cancel() {},
          finish: async () => { if (options?.utteranceId === 'warm-up') stream.audioListener?.(new Uint8Array(1024)); },
        };
        return stream;
      },
    }),
    helperFactory: ({ onEvent }) => {
      const helper = {
        start: async options => {
          events.push(`start:${path.basename(options.recordingPath)}`);
          if (overrides.helperError) setTimeout(() => onEvent({ type: 'error', message: 'audio helper failed' }), 0);
        },
        play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {},
        stop: async () => { events.push('stop'); onEvent({ type: 'recording', state: 'closed' }); },
      };
      return helper;
    },
    callSound: () => ({ process: buffer => buffer, reset() {} }),
    callRoom: seed => ({ seed, rt60Ms: 300 }),
    callCodec: () => ({ process: buffer => buffer, flush: () => Buffer.alloc(0), reset() {} }),
    trackFactory: () => ({ started() {}, ended() {}, addUtterance() {}, finalize: async () => { events.push('finalize'); } }),
    earFactory: () => ({ noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [] }),
    sessionsFactory: () => ({ start: async () => {} }),
    planCall: fakePlanner(),
    prompts: { buildOpenerInstructions: () => 'opener', buildInterviewerInstructions: () => 'interviewer' },
    restartSession: async () => sessions,
    usageLimit: () => (overrides.usage ? { resumeAt: 1 } : null),
    engineFactory: options => {
      engineListener = options.onEvent;
      return {
        start() { engineEvents.push('start'); options.onEvent({ type: 'phase', phase: 'listening' }); },
        hangUp() { engineEvents.push('hangup'); },
        helperEvent(event) { engineEvents.push(event.type); },
        state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000 }),
        typed() {},
      };
    },
    mixdown: async ({ outPath }) => { events.push(`mix:${path.basename(outPath)}`); return { durationMs: 4000 }; },
    afconvert: async () => { events.push('afconvert'); },
    analyze: async () => ({ status: 'ready', chapters: [], feedback: { summary: 'ok' } }),
    ...overrides.deps,
  };
  return { deps, events, engineEvents, engine: () => engineListener };
}

test('consent, download, usage warning, ringing and answer', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-consent-'));
  const { deps, events } = makeDeps({ tmp, usage: true });
  const service = createPracticeCallService(deps);
  const states = [];
  service.onState(state => states.push(state));
  let state = await service.start(ARGS);
  assert.equal(state.phase, 'consent');
  state = await service.agreeModelDownload();
  assert.equal(state.phase, 'ringing');
  assert.equal(state.usageWarning !== null, true);
  assert.deepEqual(events.filter(item => item.startsWith('ensure:')), ['ensure:smartTurn', 'ensure:tone']);
  assert.equal(state.persona.role.length > 0, true);
  assert.equal(JSON.stringify(state).includes('key-should-never-be-logged'), false);
  state = await service.answer();
  assert.equal(state.phase, 'in-call');
  assert.equal(service.getPreparedCards()[0].question, CARD.question);
  assert.equal(states.some(item => item.phase === 'downloading'), true);
});

test('hang-up finalises in order and deletes WAVs only with audio', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-finish-'));
  const finished = [];
  const spyFs = new Proxy(nodeFs, {
    get(target, property) {
      if (property === 'writeFile') return async (file, data, options) => { if (!path.basename(file).startsWith('.')) finished.push(`write:${path.basename(file)}`); return target.writeFile(file, data, options); };
      if (property === 'rename') return async (from, to) => { finished.push(`write:${path.basename(to)}`); return target.rename(from, to); };
      if (property === 'unlink') return async file => { finished.push(`unlink:${path.basename(file)}`); return target.unlink(file); };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { deps, events } = makeDeps({
    tmp, modelReady: true, storeFs: spyFs,
    deps: { afconvert: async args => { await nodeFs.writeFile(args.at(-1), 'm4a'); finished.push('afconvert'); } },
  });
  deps.fs = spyFs;
  deps.analyze = async () => { finished.push('analyze'); return { status: 'ready', chapters: [], feedback: null }; };
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  await nodeFs.writeFile(path.join(callDir, 'candidate.wav'), 'candidate');
  await nodeFs.writeFile(path.join(callDir, 'interviewer.wav'), 'interviewer');
  const state = await service.hangUp();
  assert.equal(state.phase, 'replay');
  assert.deepEqual(finished.filter(op => op.startsWith('write:') || op === 'afconvert' || op === 'analyze'),
    ['write:call.json', 'afconvert', 'write:call.json', 'analyze', 'write:analysis.json']);
  const analysisAt = finished.indexOf('write:analysis.json');
  assert.equal(finished.indexOf('unlink:candidate.wav') > analysisAt, true);
  assert.equal(finished.indexOf('unlink:interviewer.wav') > analysisAt, true);
  assert.equal(finished.includes('unlink:call.m4a'), false);
  assert.equal(events.includes('finalize'), true);
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.voiceId, 'v1');
  assert.equal(record.transcript[0].text, 'hello');
});

test('leaving without feedback saves the recording and spends nothing on analysis', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-no-feedback-'));
  const { deps } = makeDeps({ tmp, modelReady: true, deps: { afconvert: async args => { await nodeFs.writeFile(args.at(-1), 'm4a'); } } });
  let analysed = 0;
  let transcribed = 0;
  deps.analyze = async () => { analysed += 1; return { status: 'ready', chapters: [], feedback: null }; };
  deps.transcribe = async () => { transcribed += 1; return { words: [] }; };
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  await nodeFs.writeFile(path.join(callDir, 'candidate.wav'), 'candidate');
  await nodeFs.writeFile(path.join(callDir, 'interviewer.wav'), 'interviewer');
  const state = await service.hangUp({ feedback: false });
  assert.equal(state.phase, 'replay');
  assert.equal(state.feedbackRequested, false);
  assert.equal(analysed + transcribed, 0, 'no analysis or transcription runs');
  assert.equal(await deps.store.readAnalysis('call-1'), null, 'no analysis is stored');
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.feedbackSkipped, true);
  assert.equal(record.transcript[0].text, 'hello');
  assert.equal((await service.getReplay('call-1')).feedback, null);
});

test('hang-up from every phase is safe', async () => {
  for (const [phase, setup] of [
    ['ringing', async service => service.start(ARGS)],
    ['in-call', async service => { await service.start(ARGS); return service.answer(); }],
    ['ended', async service => { await service.start(ARGS); return service.hangUp(); }],
  ]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-phase-'));
    const service = createPracticeCallService(makeDeps({ tmp, modelReady: true }).deps);
    await setup(service);
    const state = await service.hangUp();
    assert.equal(['replay', 'error'].includes(state.phase), true, phase);
  }
});

test('engine ended and helper error end the call', async () => {
  const endedTmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-ended-'));
  const ended = makeDeps({ tmp: endedTmp, modelReady: true });
  const endedService = createPracticeCallService(ended.deps);
  await endedService.start(ARGS);
  await endedService.answer();
  ended.engine()({ type: 'ended', reason: 'interviewer' });
  await new Promise(resolve => setTimeout(resolve, 20));
  // The interviewer leaving does not end the call for the candidate.
  assert.equal(endedService.getState().phase, 'in-call');
  assert.equal(endedService.getState().interviewerLeft, true);
  assert.equal((await endedService.hangUp()).phase, 'replay');
  assert.equal((await ended.deps.store.readRecord('call-1')).reason, 'interviewer');
  ended.engine()({ type: 'ended', reason: 'timeout' });
  const errorTmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-helper-error-'));
  const failed = makeDeps({ tmp: errorTmp, modelReady: true, helperError: true });
  const errorService = createPracticeCallService(failed.deps);
  await errorService.start(ARGS);
  await errorService.answer();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(['ended', 'analyzing', 'replay'].includes(errorService.getState().phase), true);
  const record = await failed.deps.store.readRecord('call-1');
  assert.equal(record.reason, 'helper-error');
});

test('replay protocol serves ranges, rejects unknowns and symlinks', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-protocol-'));
  const store = createCallStore({ rootDir: path.join(tmp, 'practice-calls') });
  await store.ensure('call-a');
  const audio = path.join(tmp, 'practice-calls', 'call-a', 'call.m4a');
  await writeFile(audio, Buffer.from('0123456789'));
  await store.writeRecord('call-a', { callId: 'call-a', nodeId: 'node-1', startedAt: 1, durationMs: 10, persona: {} });
  const handler = createReplayHandler({ store });
  const full = await handler(new Request('practice-call://call-a/call.m4a'));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mp4');
  assert.equal(Buffer.from(await full.arrayBuffer()).toString(), '0123456789');
  const ranged = await handler(new Request('practice-call://call-a/call.m4a', { headers: { range: 'bytes=2-5' } }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), '2345');
  assert.equal((await handler(new Request('practice-call://unknown/call.m4a'))).status, 404);
  assert.equal((await handler(new Request('practice-call://call-a/../call.json'))).status, 404);
  await symlink(audio, path.join(tmp, 'practice-calls', 'call-a', 'link.wav'));
  const record = await store.readRecord('call-a');
  assert.equal(record.callId, 'call-a');
  assert.equal((await readFile(audio, 'utf8')), '0123456789');
  const deleted = await store.deleteRecording('call-a');
  assert.deepEqual(deleted.deleted.includes('candidate.wav'), false);
  assert.equal((await store.readRecord('call-a')).callId, 'call-a');
});

test('steering reaches both instruction builders and the saved record', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-steering-'));
  const validated = [];
  const built = [];
  const prompts = {
    buildOpenerInstructions: options => { built.push({ kind: 'opener', options }); return 'opener'; },
    buildInterviewerInstructions: options => { built.push({ kind: 'main', options }); return 'interviewer'; },
  };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: { prompts, validateArgs: args => validated.push(args) } });
  const service = createPracticeCallService(deps);
  const focus = 'Final round: ask my salary expectations.';
  const state = await service.start({ ...ARGS, steering: `  ${focus}  ` });
  assert.equal(state.phase, 'ringing');
  assert.deepEqual([...new Set(built.map(item => item.kind))].sort(), ['main', 'opener'], 'both sessions are built');
  assert.equal(built.length > 0, true);
  for (const item of built) assert.equal(item.options.steering, focus, `${item.kind}: the trimmed steering is passed through`);
  assert.deepEqual(validated, [ARGS], 'the strict validator sees exactly the six keys');
  await service.answer();
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.steering, focus, 'the saved record keeps the trimmed steering');
});

test('a start without steering validates with exactly the six keys and records no steering', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-no-steering-'));
  const validated = [];
  const built = [];
  const prompts = {
    buildOpenerInstructions: options => { built.push({ kind: 'opener', options }); return 'opener'; },
    buildInterviewerInstructions: options => { built.push({ kind: 'main', options }); return 'interviewer'; },
  };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: { prompts, validateArgs: args => validated.push(args) } });
  const service = createPracticeCallService(deps);
  const state = await service.start({ ...ARGS });
  assert.equal(state.phase, 'ringing');
  assert.equal(validated.length, 1);
  assert.deepEqual(Object.keys(validated[0]).sort(), Object.keys(ARGS).sort());
  assert.equal('steering' in validated[0], false);
  assert.equal(built.length > 0, true);
  for (const item of built) assert.equal(item.options.steering, '');
  await service.answer();
  await service.hangUp();
  assert.equal((await deps.store.readRecord('call-1')).steering, null);
});

test('steering that is too long or not a string is invalid-request before the strict validator runs', async () => {
  for (const [label, steering] of [['1001 chars', 'x'.repeat(1001)], ['number', 42], ['object', { text: 'hi' }], ['array', ['hi']]]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-steering-bad-'));
    const validated = [];
    const { deps } = makeDeps({ tmp, modelReady: true, deps: { validateArgs: args => validated.push(args) } });
    const service = createPracticeCallService(deps);
    const state = await service.start({ ...ARGS, steering });
    assert.equal(state.phase, 'error', label);
    assert.equal(state.error.code, 'invalid-request', label);
    assert.deepEqual(validated, [], `${label}: the strict six-key validator is never reached`);
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-steering-max-'));
  const service = createPracticeCallService(makeDeps({ tmp, modelReady: true }).deps);
  const state = await service.start({ ...ARGS, steering: `  ${'x'.repeat(1000)}  ` });
  assert.equal(state.phase, 'ringing', 'the 1000-character limit applies to the trimmed text');
});

test('setPaused forwards to the engine, publishes from the engine event, saves pausedMs and clears on hang-up', async () => {
  let now = 1000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const forwarded = [];
  const emitted = {};
  const { service, deps } = await liveCall({ deps: {
    clock,
    engineFactory: options => ({
      start() { emitted.fn = options.onEvent; options.onEvent({ type: 'phase', phase: 'listening' }); },
      hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }),
      setPaused(value) { forwarded.push(value); },
    }),
  } });
  const engine = () => emitted.fn;
  assert.equal(service.getState().paused, false);
  service.setPaused(true);
  assert.deepEqual(forwarded, [], 'no call yet');
  await service.start(ARGS);
  await service.answer();
  service.setPaused(true);
  assert.deepEqual(forwarded, [true]);
  assert.equal(service.getState().paused, false, 'the engine event is the source of truth');
  now += 2000;
  engine()({ type: 'paused', paused: true });
  assert.equal(service.getState().paused, true);
  now += 5000;
  engine()({ type: 'paused', paused: false });
  assert.equal(service.getState().paused, false);
  engine()({ type: 'paused', paused: true });
  now += 3000;
  await service.hangUp();
  assert.equal(service.getState().paused, false);
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.pausedMs, 8000);
});

test('setPaused is ignored after the interviewer left', async () => {
  const forwarded = [];
  const emitted = {};
  const { service } = await liveCall({ deps: {
    engineFactory: options => ({
      start() { emitted.fn = options.onEvent; options.onEvent({ type: 'phase', phase: 'listening' }); },
      hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }),
      setPaused(value) { forwarded.push(value); },
    }),
  } });
  const engine = () => emitted.fn;
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'paused', paused: true });
  engine()({ type: 'ended', reason: 'interviewer' });
  assert.equal(service.getState().interviewerLeft, true);
  assert.equal(service.getState().paused, false, 'the interviewer leaving clears the pause');
  service.setPaused(true);
  assert.deepEqual(forwarded, []);
});

test('the call timer freezes while paused and does not jump afterwards', async () => {
  let now = 1000;
  let tick = null;
  const clock = { now: () => now, setTimeout: fn => { tick = fn; return 1; }, clearTimeout: () => {} };
  const { service, engine } = await liveCall({ deps: { clock } });
  await service.start(ARGS);
  await service.answer();
  now += 10000;
  tick();
  assert.equal(service.getState().elapsedMs, 10000);
  engine()({ type: 'paused', paused: true });
  now += 30000;
  tick();
  assert.equal(service.getState().elapsedMs, 10000);
  engine()({ type: 'paused', paused: false });
  assert.equal(service.getState().elapsedMs, 10000, 'no jump on resume');
  now += 2000;
  tick();
  assert.equal(service.getState().elapsedMs, 12000);
});

export default cases;

// --- guards against the real modules the service now imports on demand -----

const startOf = async overrides => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-real-'));
  const built = makeDeps({ tmp, modelReady: true, ...overrides });
  return { tmp, ...built, service: createPracticeCallService(built.deps) };
};

test('every DEFAULTS factory resolves to a function of the real modules', async () => {
  const { DEFAULTS, MODULES } = await import('../../electron/practiceCall/callService.js');
  const names = Object.keys(DEFAULTS);
  assert.equal(names.length >= 18, true);
  for (const name of names) {
    assert.equal(typeof DEFAULTS[name], 'function', `${name} is a lazy factory`);
    const value = await DEFAULTS[name]();
    assert.equal(typeof value, 'function', `${name} resolves to a function`);
  }
  for (const name of ['voiceFactory', 'subscriptionTier', 'rateForTier', 'transcribeVerbatim', 'earFactory', 'analyze']) {
    assert.equal(names.includes(name), true, `${name} is a default`);
  }
  const prompts = await MODULES.prompts();
  assert.equal(typeof prompts.buildInterviewerInstructions, 'function');
  const catalog = await MODULES.catalog();
  assert.equal(typeof catalog.pickPersonaVoice, 'function');
});

test('the tier comes from the dialogue voice module and sets the voice rate', async () => {
  const seen = {};
  const tempo = [];
  const { service } = await startOf({ deps: {
    fetch: async () => { throw new Error('the service must not fetch the subscription itself'); },
    subscriptionTier: async options => { seen.tierOptions = options; return 'paid'; },
    rateForTier: tier => { seen.rated = tier; return 44100; },
    voiceFactory: options => {
      seen.voice = options;
      // The unsaved library voice answers its warm-up line, so the call can ring.
      return {
        open: () => ({
          onAudio(listener) { seen.warmAudio = listener; }, onWords() {}, sendText() {}, cancel() {},
          finish: async () => { seen.warmAudio?.(new Uint8Array(1024)); },
        }),
      };
    },
    trackFactory: options => { seen.track = options; tempo.push('track'); return { started() {}, ended() {}, addUtterance() {}, finalize: async () => {} }; },
    catalog: {
      listConversationalVoices: async () => [{ voiceId: 'v1', name: 'Ada Lovelace' }],
      pickPersonaVoice: options => ({ voiceId: 'v1', name: 'Ada Lovelace', temperament: options.temperament }),
    },
  } });
  await service.start(ARGS);
  assert.equal(seen.tierOptions.key, 'key-should-never-be-logged');
  assert.equal(seen.voice.tier, 'paid');
  assert.equal(seen.rated, 'paid');
  assert.deepEqual(seen.track, { sampleRate: 44100 });
});

test('the ElevenLabs key is read without a promisified execFile', async () => {
  const calls = [];
  const { service } = await startOf({ deps: { readKey: (...args) => { calls.push(args); return 'key-1'; } } });
  await service.start(ARGS);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], []);
});

test('the lead\'s temperament comes from the plan unless the request or the brief fixes one', async () => {
  const sessionsOf = () => {
    const starts = [];
    let made = 0;
    const factory = () => {
      const kind = ['opener', 'main', 'classifier'][made++];
      return { start: async ({ instructions }) => { starts.push({ kind, instructions }); return { reply: 'READY' }; } };
    };
    return { starts, factory };
  };
  const character = { traits: 'Dominant, Firm', descriptive: '', about: 'Brash and openly confident.' };
  const run = async ({ planned, loadBrief } = {}) => {
    const seen = {};
    const { starts, factory } = sessionsOf();
    const built = await startOf({ modelReady: true, deps: {
      random: () => 0,
      sessionsFactory: factory,
      planCall: fakePlanner(voices => soloPlan(voices, { lead: { ...soloPlan(voices).lead, temperament: planned } })),
      prompts: {
        buildInterviewerInstructions: ({ persona }) => `main:${persona.temperament}:${persona.voice?.character?.traits}`,
        buildOpenerInstructions: ({ persona }) => `opener:${persona.temperament}`,
      },
      catalog: {
        listConversationalVoices: async () => [{ voiceId: 'v1', name: 'Ada Lovelace' }],
        pickPersonaVoice: options => {
          if (seen.temperament === undefined) seen.temperament = options.temperament; // the lead's pick is the first one
          return { voiceId: 'v1', name: 'Ada Lovelace', gender: 'male', age: 'middle_aged', accent: 'american', character, temperament: null };
        },
      },
    } });
    if (loadBrief) built.deps.loadBrief = loadBrief(built.deps.loadBrief);
    const service = createPracticeCallService(built.deps);
    const state = await service.start(ARGS);
    return { seen, starts, state, built };
  };
  const chosen = await run({ planned: 'tough' });
  assert.equal(chosen.seen.temperament, null, 'no temperament is imposed on the voice pick');
  assert.equal(chosen.starts.find(item => item.kind === 'main').instructions, 'main:tough:Dominant, Firm');
  assert.equal(chosen.starts.find(item => item.kind === 'opener').instructions, 'opener:tough');
  assert.equal(chosen.state.persona.role, 'Hiring Manager');
  assert.equal(chosen.state.persona.team, 'the hiring team');
  assert.equal(chosen.built.deps.planCall.calls[0].voices[0].description.includes('Dominant, Firm'), true, 'the planner is told how the voice sounds');

  const warm = await run({ planned: 'warm' });
  assert.equal(warm.starts.find(item => item.kind === 'opener').instructions, 'opener:warm');

  const asked = await run({
    planned: 'warm',
    loadBrief: brief => async args => {
      const loaded = await brief(args);
      return { ...loaded, role: { ...loaded.role, team: 'Platform' }, practice: { temperament: 'tough' } };
    },
  });
  assert.equal(asked.seen.temperament, 'tough');
  assert.equal(asked.starts.find(item => item.kind === 'main').instructions, 'main:tough:Dominant, Firm', 'a fixed temperament wins over the plan');
  assert.equal(asked.starts.find(item => item.kind === 'opener').instructions, 'opener:tough');
  assert.equal(asked.state.persona.team, 'Platform');
});

test('analysis gets the Claude text call and a Scribe transcribe closure', async () => {
  const seen = {};
  const callText = async () => ({ ok: true });
  const transcribeVerbatim = async options => { seen.transcribe = options; return { text: 'verbatim words', words: [] }; };
  const { tmp, service } = await startOf({ deps: {
    callText, transcribeVerbatim,
    analyze: async input => {
      seen.input = input;
      const text = await input.deps.transcribe({ path: path.join(tmp, 'practice-calls', 'call-1', 'candidate.wav') });
      return { analysis: { status: 'ready', chapters: [], transcriptText: text.text }, feedback: { summary: 'ok' } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  assert.equal(seen.input.deps.callText, callText);
  assert.equal(typeof seen.input.deps.transcribe, 'function');
  assert.equal(seen.input.callDir, path.join(tmp, 'practice-calls', 'call-1'));
  assert.equal(seen.transcribe.path, path.join(tmp, 'practice-calls', 'call-1', 'candidate.wav'));
  assert.equal(seen.transcribe.key, 'key-should-never-be-logged');
  const replay = await service.getReplay('call-1');
  assert.equal(replay.feedback.callId, 'call-1');
});

test('feedback is saved through the practice registry after the call', async () => {
  for (const alreadyArmed of [false, true]) {
    const log = [];
    let arms = 0;
    const registry = {
      arm: async request => {
        arms += 1;
        log.push(`arm:${request.nodeId}:${request.company}:${request.role}:${request.questionCount}`);
        if (alreadyArmed && arms === 1) throw Object.assign(new Error('already armed'), { code: 'already_armed' });
        return 'session-1';
      },
      cancel: nodeId => { log.push(`cancel:${nodeId}`); },
      finish: (code, feedback) => { log.push(`finish:${code}:${feedback.callId}`); return { status: 'accepted' }; },
    };
    const feedbackErrors = [];
    const { service } = await startOf({ deps: {
      registry,
      analyze: async () => ({ status: 'ready', chapters: [], feedback: { summary: 'solid', callId: null } }),
    } });
    service.onEvent(event => { if (event.kind === 'feedback-error') feedbackErrors.push(event); });
    await service.start(ARGS);
    await service.answer();
    const state = await service.hangUp();
    assert.equal(state.phase, 'replay');
    assert.equal(log.includes('arm:node-1:Acme:Engineer:1'), true);
    // The call is the only thing that arms a session, so one found armed is a leftover from a call
    // whose feedback was never stored: it is closed and this call's feedback is saved.
    assert.equal(log.includes('cancel:node-1'), alreadyArmed);
    assert.equal(log.filter(item => item.startsWith('arm:')).length, alreadyArmed ? 2 : 1);
    assert.equal(log.includes('finish:session-1:call-1'), true);
    assert.equal(feedbackErrors.length, 0);
  }
});

test('the ear gets the smart-turn and tone model paths plus the candidate recording', async () => {
  const seen = { names: [] };
  const { tmp, service } = await startOf({ deps: {
    modelStore: () => ({
      status: () => ({ smartTurn: 'ready', tone: 'ready' }),
      ensure: async () => {},
      pathOf: name => { seen.names.push(name); return path.join(tmp, 'practice-models', `${name}.onnx`); },
    }),
    earFactory: options => {
      seen.ear = options;
      return { noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [] };
    },
  } });
  await service.start(ARGS);
  assert.deepEqual(seen.names, ['smartTurn', 'tone']);
  assert.equal(seen.ear.smartTurnPath, path.join(tmp, 'practice-models', 'smartTurn.onnx'));
  assert.equal(seen.ear.tonePath, path.join(tmp, 'practice-models', 'tone.onnx'));
  assert.equal(seen.ear.candidatePath, path.join(tmp, 'practice-calls', 'call-1', 'candidate.wav'));
  assert.equal(typeof seen.ear.onToneSample, 'function');
});

test('the ear gets an inference factory that names the built worker entry', async () => {
  const seen = { options: [], factories: [] };
  const worker = { endOfTurn: async () => 0.5, tone: async () => null, close() {} };
  const earFactory = options => {
    seen.factories.push(options.inference);
    return { noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [] };
  };
  const inference = async options => { seen.options.push(options); return worker; };
  const built = path.join('dist-electron', 'inferenceWorkerThread.js');
  const models = { smartTurnPath: '/models/smart-turn.onnx', tonePath: '/models/tone.onnx' };

  const first = await startOf({ modelReady: true, deps: { inference, inferenceWorkerPath: built, earFactory } });
  await first.service.start(ARGS);
  assert.equal(typeof seen.factories[0], 'function');
  assert.equal(await seen.factories[0]({ ...models }), worker);
  assert.deepEqual(seen.options[0], { ...models, workerPath: built });

  const second = await startOf({ modelReady: true, deps: { inference, earFactory } });
  await second.service.start(ARGS);
  await seen.factories[1]({ ...models });
  assert.equal(seen.options[1].workerPath, undefined, 'without the option the source-tree default applies');
});

test('model download reports progress before ringing', async () => {
  const ensured = [];
  const { tmp, service } = await startOf({ modelReady: false, deps: {
    modelStore: () => ({
      status: () => ({ smartTurn: 'missing', tone: 'missing' }),
      ensure: async (name, { onProgress }) => { ensured.push(name); onProgress?.({ receivedBytes: 10, totalBytes: 100 }); },
      pathOf: name => path.join(tmp, 'practice-models', `${name}.onnx`),
    }),
  } });
  const states = [];
  service.onState(state => states.push(state));
  let state = await service.start(ARGS);
  assert.equal(state.phase, 'consent');
  state = await service.agreeModelDownload();
  assert.equal(state.phase, 'ringing');
  assert.deepEqual(ensured, ['smartTurn', 'tone']);
  assert.equal(states.some(item => item.phase === 'downloading' && item.modelDownload?.receivedBytes === 10), true);
});

test('hang-up from precheck and connecting is safe', async () => {
  let releaseKey;
  const precheck = await startOf({ deps: { readKey: () => new Promise(resolve => { releaseKey = () => resolve('key-1'); }) } });
  const pending = precheck.service.start(ARGS);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(precheck.service.getState().phase, 'precheck');
  assert.equal((await precheck.service.hangUp()).phase, 'replay');
  releaseKey();
  await pending.catch(() => {});
  const connecting = await startOf({ deps: {
    engineFactory: options => ({ start() { options.onEvent({ type: 'phase', phase: 'listening' }); }, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }),
  } });
  await connecting.service.start(ARGS);
  const answering = connecting.service.answer();
  assert.equal(connecting.service.getState().phase, 'connecting');
  assert.equal((await connecting.service.hangUp()).phase, 'replay');
  await answering.catch(() => {});
});

test('a symlinked recording is never served', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-symlink-'));
  const store = createCallStore({ rootDir: path.join(tmp, 'practice-calls') });
  await store.ensure('call-b');
  const secret = path.join(tmp, 'secret.m4a');
  await writeFile(secret, 'secret-bytes');
  await symlink(secret, path.join(tmp, 'practice-calls', 'call-b', 'call.m4a'));
  const handler = createReplayHandler({ store });
  const response = await handler(new Request('practice-call://call-b/call.m4a'));
  assert.equal(response.status, 404);
  assert.notEqual(await response.text(), 'secret-bytes');
});

test('R1 mirror playback forwards to the helper and fills the real interviewer track', async () => {
  const { createInterviewerTrack } = await import('../../electron/practiceCall/audio/trackWriter.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r1-'));
  const seen = { plays: [] };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    trackFactory: options => { seen.options = options; seen.track = createInterviewerTrack(options); return seen.track; },
    helperFactory: () => ({
      start: async () => ({ ok: true }), play: (id, rate) => { seen.plays.push([id, rate]); return { ok: true }; },
      pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => {},
    }),
    engineFactory: options => { seen.audio = options.audio; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  assert.equal(seen.audio.play('u1', 24000).ok, true);
  seen.audio.pushAudio('u1', Buffer.alloc(4800), 24000);
  seen.audio.endUtterance('u1');
  seen.audio.helperEvent({ type: 'playback', utteranceId: 'u1', state: 'started', atMs: 1300, positionMs: 0 });
  seen.audio.helperEvent({ type: 'playback', utteranceId: 'u1', state: 'finished', atMs: 1500, positionMs: 100 });
  assert.deepEqual(seen.plays, [['u1', 24000]]);
  assert.deepEqual(seen.options, { sampleRate: 44100 });
  const segments = seen.track.segments('u1');
  assert.equal(segments.length >= 1, true);
  assert.deepEqual(segments.at(-1), { wallStartMs: 1300, audioStartMs: 0, audioEndMs: 100 });
});

test('R1b the mirror applies no treatment of its own: audio reaches the helper as given', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-sound-'));
  const seen = { pushed: [] };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    callSound: () => { throw new Error('the mirror must not build a processor'); },
    helperFactory: () => ({
      start: async () => ({ ok: true }), play() {}, pushAudio: (id, pcm) => { seen.pushed.push(Buffer.from(pcm)); },
      endUtterance() {}, cancel() {}, mute() {}, stop: async () => {},
    }),
    engineFactory: options => { seen.audio = options.audio; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const input = Buffer.alloc(4800);
  for (let at = 0; at < input.length; at += 2) input.writeInt16LE(Math.round(8000 * Math.sin(at / 20)), at);
  seen.audio.play('u1', 24000);
  seen.audio.pushAudio('u1', input, 24000);
  assert.deepEqual(seen.pushed[0], input);
});

test('R2 helper playback events keyed by utteranceId drive the track with helper timing', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r2-'));
  const calls = [];
  const track = {
    addUtterance: () => calls.push(['add']), started: (id, atMs) => calls.push(['started', id, atMs]),
    paused: (id, positionMs, atMs) => calls.push(['paused', id, positionMs, atMs]), resumed: (id, atMs) => calls.push(['resumed', id, atMs]),
    ended: (id, positionMs, atMs) => calls.push(['ended', id, positionMs, atMs]), finalize: async () => {},
  };
  let helperEvent;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    trackFactory: () => track,
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => {} };
    },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  helperEvent({ type: 'playback', utteranceId: 'u1', state: 'started', atMs: 700, positionMs: 0 });
  helperEvent({ type: 'playback', utteranceId: 'u1', state: 'paused', atMs: 900, positionMs: 25 });
  helperEvent({ type: 'playback', utteranceId: 'u1', state: 'resumed', atMs: 1200 });
  helperEvent({ type: 'playback', utteranceId: 'u1', state: 'finished', atMs: 1500, positionMs: 60 });
  helperEvent({ type: 'playback', state: 'started', atMs: 1, positionMs: 0 });
  assert.deepEqual(calls, [
    ['started', 'u1', 700], ['paused', 'u1', 25, 900], ['resumed', 'u1', 1200], ['ended', 'u1', 60, 1500],
  ]);
});

test('R3 failing the engine stops helper, ear and sessions, then a fresh start works', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r3-'));
  const stopped = [];
  let ids = 0;
  let engineAttempts = 0;
  const ear = { noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [], settle: async () => {}, close: () => stopped.push('ear') };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    newId: () => `call-${++ids}`,
    trackFactory: () => ({ started() {}, ended() {}, addUtterance() {}, finalize: async () => {} }),
    earFactory: () => ear,
    sessionsFactory: () => ({ start: async () => {}, close: () => stopped.push('session') }),
    helperFactory: () => ({ start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { stopped.push('helper'); } }),
    engineFactory: () => {
      engineAttempts += 1;
      if (engineAttempts === 1) return { start() { throw new Error('engine broke'); }, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
      return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
    },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  assert.equal((await service.answer()).phase, 'error');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped.includes('helper'), true);
  assert.equal(stopped.includes('ear'), true);
  assert.equal(stopped.includes('session'), true);
  const again = await service.start(ARGS);
  assert.equal(again.phase, 'ringing');
  assert.equal((await service.answer()).phase, 'in-call');
});

test('R4 a refused helper start fails the call with the helper code', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r4-'));
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    helperFactory: () => ({ start: async () => ({ ok: false, code: 'mic-denied' }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => {} }),
  } });
  const state = await createPracticeCallService(deps).start(ARGS);
  assert.equal(state.phase, 'error');
  assert.equal(state.error.code, 'mic-denied');
});

test('R5 two concurrent starts create one call and one already-running result', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r5-'));
  let briefs = 0;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    loadBrief: async (...args) => { briefs += 1; await new Promise(resolve => setTimeout(resolve, 5)); return makeDeps({ tmp }).deps.loadBrief(...args); },
  } });
  const service = createPracticeCallService(deps);
  const [first, second] = await Promise.all([service.start(ARGS), service.start(ARGS)]);
  assert.equal(briefs, 1);
  assert.equal([first.phase, second.phase].filter(phase => phase === 'ringing').length, 1);
  const blocked = [first, second].find(state => state.phase === 'error');
  assert.equal(blocked.error.code, 'already-running');
  assert.equal(service.getState().callId, 'call-1');
  assert.equal([first, second].filter(state => state.callId === 'call-1').length >= 1, true);
});

test('R7 finishCall keeps its own call snapshot across the analysis wait', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r7-'));
  let releaseAnalysis;
  let ids = 0;
  const gate = new Promise(resolve => { releaseAnalysis = resolve; });
  let analysed = 0;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    newId: () => `call-${++ids}`,
    analyze: async () => { analysed += 1; await gate; return { status: 'ready', chapters: [], feedback: { summary: 'first' } }; },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  const finishing = service.hangUp();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.getState().callId, 'call-1');
  assert.equal(service.getState().phase, 'analyzing');
  const blocked = await service.start(ARGS);
  assert.equal(blocked.error.code, 'already-running');
  releaseAnalysis();
  const state = await finishing;
  assert.equal(state.phase, 'replay');
  assert.equal(analysed, 1);
  const replay = await service.getReplay('call-1');
  assert.equal(replay.feedback.summary, 'first');
  const next = await service.start(ARGS);
  assert.equal(next.callId, 'call-2');
  assert.equal((await service.getReplay('call-1')).callId, 'call-1');
});

test('R8 a pre-call abort deletes the directory and never analyses', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r8-'));
  let releaseKey;
  let analysed = 0;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    readKey: () => new Promise(resolve => { releaseKey = () => resolve('key-1'); }),
    analyze: async () => { analysed += 1; return { status: 'ready', chapters: [], feedback: null }; },
  } });
  const service = createPracticeCallService(deps);
  const pending = service.start(ARGS);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.getState().phase, 'precheck');
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  assert.equal((await nodeFs.lstat(callDir)).isDirectory(), true);
  assert.equal((await service.hangUp()).phase, 'replay');
  await assert.rejects(nodeFs.lstat(callDir), error => error.code === 'ENOENT');
  releaseKey();
  await pending.catch(() => {});
  assert.equal(analysed, 0);
  assert.equal(await deps.store.readRecord('call-1'), null);
});

test('R9 a live call refuses to delete its recording', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r9-'));
  const { deps } = makeDeps({ tmp, modelReady: true });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  const callDir = path.join(tmp, 'practice-calls', 'call-1');
  await nodeFs.writeFile(path.join(callDir, 'candidate.wav'), 'candidate');
  await service.answer();
  assert.equal(await service.deleteRecording('call-1'), null);
  assert.equal((await nodeFs.readFile(path.join(callDir, 'candidate.wav'), 'utf8')), 'candidate');
  await service.hangUp();
  const deleted = await service.deleteRecording('call-1');
  assert.equal(deleted.deleted.includes('candidate.wav'), true);
  await assert.rejects(nodeFs.lstat(path.join(callDir, 'candidate.wav')), error => error.code === 'ENOENT');
});

test('R13 records are written to a 0600 sibling temp file and renamed', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r13-'));
  const root = path.join(tmp, 'practice-calls');
  const log = [];
  const spyFs = new Proxy(nodeFs, {
    get(target, property) {
      if (property === 'writeFile') return async (file, data, options) => { log.push({ op: 'write', file, mode: options?.mode }); return target.writeFile(file, data, options); };
      if (property === 'rename') return async (from, to) => { log.push({ op: 'rename', from, to }); return target.rename(from, to); };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = createCallStore({ rootDir: root, fs: spyFs });
  await store.writeRecord('call-1', { callId: 'call-1', nodeId: 'node-1', startedAt: 1, durationMs: 5 });
  const callDir = path.join(root, 'call-1');
  const write = log.find(entry => entry.op === 'write');
  const rename = log.find(entry => entry.op === 'rename');
  assert.equal(path.dirname(write.file), callDir);
  assert.equal(path.basename(write.file).startsWith('.call.json'), true);
  assert.equal(write.mode, 0o600);
  assert.equal(rename.from, write.file);
  assert.equal(rename.to, path.join(callDir, 'call.json'));
  assert.equal((await store.readRecord('call-1')).callId, 'call-1');
  const other = path.join(tmp, 'elsewhere');
  await nodeFs.mkdir(other);
  await nodeFs.rm(callDir, { recursive: true });
  await nodeFs.symlink(other, callDir);
  await assert.rejects(store.remove('call-1'), error => error.code === 'SYMLINK');
  assert.deepEqual(await nodeFs.readdir(other), []);
});

test('R10 window start reuses a live call window and replaces a replay window', async () => {
  const { createPracticeCallController } = await import('../../electron/practiceCall/callWindow.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r10-'));
  const windows = [];
  class FakeWindow {
    constructor(options) {
      this.options = options; this.destroyed = false; this.handlers = {};
      this.webContents = { send() {}, mainFrame: {} };
      windows.push(this);
    }
    once(name, fn) { this.handlers[name] = fn; }
    on(name, fn) { this.handlers[name] = fn; }
    isDestroyed() { return this.destroyed; }
    show() {} focus() {} loadURL(url) { this.url = url; } loadFile(file, options) { this.file = file; this.search = options.search; }
    close() { if (this.destroyed) return; this.destroyed = true; this.handlers.closed?.(); }
  }
  const ipc = new Map();
  const ipcMain = { handle: (channel, fn) => ipc.set(channel, fn), removeHandler: channel => ipc.delete(channel) };
  const invoke = (channel, args) => ipc.get(channel)({}, args);
  const abandons = [];
  let starts = 0;
  const service = {
    onState() {}, onEvent() {}, onReplayUpdated() {},
    getState: () => ({ phase: 'ringing', callId: 'call-1' }),
    start: async () => { starts += 1; return { phase: 'ringing', callId: 'call-1' }; },
    abandon: async () => { abandons.push(1); return { phase: 'replay' }; },
  };
  createPracticeCallController({
    BrowserWindow: FakeWindow, ipcMain, isAuthorizedOwner: () => true, userDataPath: tmp,
    store: { readRecord: async callId => ({ callId, nodeId: 'n1' }) }, service,
  });
  const first = await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(first.phase, 'ringing');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].search, 'view=practice-call&callId=call-1');
  const blocked = await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(blocked.error.code, 'already-running');
  assert.equal(starts, 1);
  assert.equal(windows.length, 1);
  const refused = await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-1' });
  assert.equal(refused.success, false, 'a replay never takes over a live call window');
  assert.equal(windows.length, 1);
  windows[0].close();
  assert.equal(abandons.length, 1, 'closing the live call window abandons the call');
  await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-1' });
  assert.equal(windows.length, 2);
  await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(windows[1].destroyed, true, 'the replay window is closed first');
  assert.equal(windows.length, 3);
  assert.equal(windows[2].search, 'view=practice-call&callId=call-1');
  windows[2].close();
  assert.equal(abandons.length, 2, 'closing a live call window abandons the call');
});

test('R11 elapsedMs ticks from the clock and level follows helper rms', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r11-'));
  const base = Date.now();
  let now = base;
  const timers = new Map();
  let timerId = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  const runTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } };
  let helperEvent;
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    clock,
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => {} };
    },
    engineFactory: options => ({
      start() { options.onEvent({ type: 'phase', phase: 'in-call' }); },
      hangUp() {},
      state: () => ({ transcript: [], elapsedMs: 0 }),
    }),
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  now = base + 1500;
  runTimers();
  const elapsed = service.getState().elapsedMs;
  assert.equal(elapsed >= 1490 && elapsed <= 1500, true, `elapsedMs was ${elapsed}`);
  helperEvent({ type: 'level', rms: 0.35 });
  assert.equal(service.getState().level, 0.35);
  helperEvent({ type: 'level', rms: 4 });
  assert.equal(service.getState().level, 1);
});

test('R12 finish waits for ear.settle before snapshotting tone samples and closes the ear', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-r12-'));
  const seen = { settle: [], closed: 0, samples: [] };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    earFactory: options => ({
      noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }),
      settle: async timeoutMs => {
        seen.settle.push(timeoutMs);
        await new Promise(resolve => setTimeout(resolve, 10));
        const sample = { atMs: 1, endMs: 2, arousal: 0.5, dominance: 0.5, valence: 0.5 };
        seen.samples.push(sample);
        options.onToneSample(sample);
      },
      toneSamples: () => seen.samples.slice(),
      close: () => { seen.closed += 1; },
    }),
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  assert.deepEqual(seen.settle, [2000]);
  assert.equal(seen.closed, 1);
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.toneSamples.length, 1);
  assert.equal(record.toneSamples[0].atMs, 1);
  assert.equal(record.toneNotes, undefined);
});

// --- the interviewer voice draw: the shared library only, warm-up and the pool file ---

// Kept only to prove that no account voice is ever drawn or picked.
const ACCOUNT_VOICES = Object.freeze([
  { voiceId: 'v1', voiceName: 'Ada - calm', gender: 'female', age: 'young', accent: 'british', useCases: ['conversational'], category: 'premade', description: '' },
  { voiceId: 'v2', voiceName: 'Bo - warm', gender: 'male', age: 'middle aged', accent: 'american', useCases: ['conversational'], category: 'premade', description: '' },
]);
const DRAWN_LIBRARY_VOICE = Object.freeze({
  voiceId: 'lib-1', voiceName: 'Nora - crisp', gender: 'female', age: 'middle aged', accent: 'american',
  useCases: ['conversational'], category: 'professional', description: 'A crisp, confident voice.',
  descriptive: 'confident', language: 'en', rate: null,
});
const SECOND_LIBRARY_VOICE = Object.freeze({
  voiceId: 'lib-2', voiceName: 'Miles - dry', gender: 'male', age: 'young', accent: 'irish',
  useCases: ['conversational'], category: 'professional', description: 'A dry, even voice.',
  descriptive: 'dry', language: 'en', rate: null,
});
const poolFilePath = tmp => path.join(tmp, 'practice-voice-pool.json');
// One raw /v1/shared-voices row, for the test that runs the real draw against a fake fetch.
const SHARED_LIBRARY_ROW = Object.freeze({
  voice_id: 'lib-1', public_owner_id: 'owner-1', name: 'Nora', category: 'high_quality',
  labels: { use_case: 'conversational', gender: 'female', accent: 'american', age: 'middle_aged', language: 'en' },
  sharing: { rate: 1 },
});
const realPoolStore = { createVoicePoolStore: options => createVoicePoolStore(options) };

/** The catalog fake records what every pick saw and every account-voice listing. */
function recordingCatalog(voices) {
  const picks = [];
  const listings = [];
  return {
    picks,
    listings,
    listConversationalVoices: async () => { listings.push(voices); return voices; },
    pickPersonaVoice: options => {
      picks.push(options);
      return { voiceId: options.voices[0].voiceId, name: 'Ada Lovelace' };
    },
  };
}

/** A voice factory whose streams are observable: they carry audio, an error, or silence. */
function voiceHarness({ audio = false, fail = false, onSend } = {}) {
  const factories = [];
  const make = options => {
    const opened = [];
    const factory = {
      options, opened,
      open: openOptions => {
        const stream = {
          utteranceId: openOptions?.utteranceId, sent: [], finished: 0, cancelled: 0,
          onAudio(listener) { stream.audioListener = listener; },
          onWords() {},
          onError(listener) { stream.errorListener = listener; },
          sendText(text) { stream.sent.push(text); onSend?.(stream); },
          async finish() {
            stream.finished += 1;
            if (fail) { stream.errorListener?.(new Error('warm-up stream failed')); throw new Error('warm-up stream failed'); }
            if (audio) stream.audioListener?.(new Uint8Array(1024));
          },
          cancel() { stream.cancelled += 1; },
        };
        opened.push(stream);
        return stream;
      },
    };
    factories.push(factory);
    return factory;
  };
  return { factories, make };
}

test('the draw gets the newest pool stamp and the service random, never the account voices', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-draw-'));
  await writeFile(poolFilePath(tmp), JSON.stringify({ version: 1, lastUsed: { 'lib-1': 500, 'lib-2': 900 } }));
  const draws = [];
  const random = () => 0.25;
  const catalog = recordingCatalog(ACCOUNT_VOICES);
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    catalog, random,
    voiceLibrary: { ...realPoolStore, drawVoice: async options => { draws.push(options); return { voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 2 }; } },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  assert.equal(draws.length, 5, 'the lead and four more voices for the planner');
  assert.equal('accountVoices' in draws[0], false, 'the draw is never handed the account voices');
  assert.deepEqual(draws[0].excludeVoiceIds, ['lib-2'], 'the newest pool stamp is the avoided voice');
  assert.equal(draws[0].random, random);
  assert.equal(draws[0].key, 'key-should-never-be-logged');
  assert.equal(draws[0].fetch, deps.fetch);
  assert.deepEqual(catalog.listings, [], 'the account voice list is never read');
  assert.equal(catalog.picks.every(pick => pick.voices.length === 1 && pick.voices[0].voiceId === 'lib-1'), true, 'only drawn library voices are picked from');
  await service.answer();
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.voiceId, 'lib-1', 'the persona is built from the drawn voice');
  assert.equal(record.persona.voiceSource, 'library');
});

test('a library draw opens one discarded warm-up line before the call rings', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-warmup-'));
  const ref = {};
  const phasesAtSend = [];
  const trackUtterances = [];
  const harness = voiceHarness({ audio: true, onSend: () => phasesAtSend.push(ref.service.getState().phase) });
  const catalog = recordingCatalog(ACCOUNT_VOICES);
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    catalog, random: () => 0,
    voiceFactory: harness.make,
    trackFactory: () => ({ started() {}, ended() {}, addUtterance(utterance) { trackUtterances.push(utterance); }, finalize: async () => {} }),
    voiceLibrary: { ...realPoolStore, drawVoice: async () => ({ voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 4 }) },
  } });
  ref.service = createPracticeCallService(deps);
  const state = await ref.service.start(ARGS);
  assert.equal(state.phase, 'ringing');
  // The plan chose the stability before anything was warmed, so one factory serves both the warm-up and the call.
  assert.equal(harness.factories.length, 1, 'only the chosen voice is made');
  assert.equal(harness.factories[0].options.voiceId, 'lib-1');
  const opened = harness.factories[0].opened;
  assert.deepEqual(opened.map(stream => stream.utteranceId), ['warm-up'], 'exactly one warm-up stream');
  assert.deepEqual(opened[0].sent, ['Hi.']);
  assert.deepEqual(phasesAtSend, ['precheck'], 'the warm-up happens before the call rings');
  assert.equal(opened[0].finished, 1);
  assert.deepEqual(trackUtterances, [], 'the warm-up audio never reaches the track');
  await ref.service.answer();
  await ref.service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.voiceSource, 'library');
  assert.equal(record.persona.voiceId, 'lib-1');
});

test('the real pool file keeps only version and lastUsed across two starts', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-pool-file-'));
  const filePath = poolFilePath(tmp);
  const draws = [];
  const voiceLibrary = {
    ...realPoolStore,
    drawVoice: async options => {
      draws.push(options);
      return { voice: draws.length === 1 ? DRAWN_LIBRARY_VOICE : SECOND_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 1 };
    },
  };
  const readPool = async () => JSON.parse(await readFile(filePath, 'utf8'));
  const depsFor = extra => makeDeps({ tmp, modelReady: true, deps: { voiceLibrary, catalog: recordingCatalog(ACCOUNT_VOICES), random: () => 0, ...extra } });

  // The real store over a real file: the point is what the precheck save leaves on disk.
  await createPracticeCallService(depsFor({}).deps).start(ARGS);
  const afterFirst = await readPool();
  assert.deepEqual(Object.keys(afterFirst).sort(), ['lastUsed', 'version'], 'nothing else survives the save');
  assert.equal(afterFirst.version, 1);
  assert.equal(afterFirst.lastUsed['lib-1'], 1000);

  // A second start on a later clock avoids the first start's voice and adds its own stamp.
  await createPracticeCallService(depsFor({
    clock: { now: () => 2000, setTimeout: () => 1, clearTimeout: () => {} },
    newId: () => 'call-2',
  }).deps).start(ARGS);
  const afterSecond = await readPool();
  assert.deepEqual(draws[1].excludeVoiceIds, ['lib-1'], 'the second draw avoids the first start voice');
  assert.deepEqual(Object.keys(afterSecond).sort(), ['lastUsed', 'version']);
  assert.equal(afterSecond.lastUsed['lib-1'], 1000);
  assert.equal(afterSecond.lastUsed['lib-2'], 2000);
});

test('a warm-up that errors or stays silent ends the call before anything is created', async () => {
  for (const [label, streamOptions] of [['errors', { fail: true }], ['no audio', { audio: false }]]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-warmup-fail-'));
    const harness = voiceHarness(streamOptions);
    const catalog = recordingCatalog(ACCOUNT_VOICES);
    const created = { helpers: 0, tracks: 0, sessions: 0 };
    const { deps } = makeDeps({ tmp, modelReady: true, deps: {
      catalog, random: () => 0,
      voiceFactory: harness.make,
      helperFactory: () => { created.helpers += 1; throw new Error('no helper after a failed warm-up'); },
      trackFactory: () => { created.tracks += 1; throw new Error('no track after a failed warm-up'); },
      sessionsFactory: () => { created.sessions += 1; throw new Error('no sessions after a failed warm-up'); },
      voiceLibrary: { ...realPoolStore, drawVoice: async () => ({ voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 1 }) },
    } });
    const service = createPracticeCallService(deps);
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'error', label);
    assert.equal(state.error.code, 'voice-warmup-failed', label);
    assert.equal(state.error.message, 'The interviewer voice did not respond. Try starting the call again.', label);
    assert.equal(harness.factories.length, 1, `${label}: only the drawn voice is opened`);
    assert.equal(harness.factories[0].options.voiceId, 'lib-1', label);
    assert.deepEqual(harness.factories[0].opened.map(stream => stream.utteranceId), ['warm-up'], label);
    assert.deepEqual(created, { helpers: 0, tracks: 0, sessions: 0 }, `${label}: nothing is created`);
    assert.deepEqual(catalog.listings, [], `${label}: the account voice list is never read`);
    const stamped = await readFile(poolFilePath(tmp), 'utf8').then(() => true, () => false);
    assert.equal(stamped, false, `${label}: no lastUsed stamp is saved`);
  }
});

test('a draw failure ends the call before anything is created', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-draw-error-'));
  const catalog = recordingCatalog(ACCOUNT_VOICES);
  const created = { helpers: 0, tracks: 0, sessions: 0 };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    catalog, random: () => 0,
    helperFactory: () => { created.helpers += 1; throw new Error('no helper after a failed draw'); },
    trackFactory: () => { created.tracks += 1; throw new Error('no track after a failed draw'); },
    sessionsFactory: () => { created.sessions += 1; throw new Error('no sessions after a failed draw'); },
    voiceLibrary: { ...realPoolStore, drawVoice: async () => { throw new Error('voice library unreachable'); } },
  } });
  const service = createPracticeCallService(deps);
  const state = await service.start(ARGS);
  assert.equal(state.phase, 'error');
  assert.equal(state.error.code, 'voice-library-unavailable');
  assert.equal(state.error.message, 'Could not load an interviewer voice from the ElevenLabs voice library. Check your internet connection and try again.');
  assert.deepEqual(created, { helpers: 0, tracks: 0, sessions: 0 }, 'nothing is created');
  assert.deepEqual(catalog.listings, [], 'the account voice list is never read');
  assert.deepEqual(catalog.picks, [], 'no voice is picked');
  const stamped = await readFile(poolFilePath(tmp), 'utf8').then(() => true, () => false);
  assert.equal(stamped, false, 'no lastUsed stamp is saved');
});

test('a missing, throwing or unusable draw is voice-library-unavailable', async () => {
  for (const [label, voiceLibrary] of [
    ['missing', { ...realPoolStore }],
    ['throwing', { ...realPoolStore, drawVoice: async () => { throw new Error('voice library unreachable'); } }],
    ['unusable', { ...realPoolStore, drawVoice: async () => ({ voice: { voiceName: 'No id' }, source: 'library', libraryTotal: 3427, attempts: 1 }) }],
  ]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-draw-fail-'));
    const catalog = recordingCatalog(ACCOUNT_VOICES);
    const { deps } = makeDeps({ tmp, modelReady: true, deps: { catalog, random: () => 0, voiceLibrary } });
    const service = createPracticeCallService(deps);
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'error', label);
    assert.equal(state.error.code, 'voice-library-unavailable', label);
    assert.equal(state.error.message,
      'Could not load an interviewer voice from the ElevenLabs voice library. Check your internet connection and try again.', label);
    assert.deepEqual(catalog.listings, [], `${label}: the account voice list is never read`);
    const stamped = await readFile(poolFilePath(tmp), 'utf8').then(() => true, () => false);
    assert.equal(stamped, false, `${label}: no lastUsed stamp is saved`);
  }
});

test('closing the window during a call asks how to leave before it closes', async () => {
  const { createPracticeCallController } = await import('../../electron/practiceCall/callWindow.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-close-ask-'));
  const sent = [];
  let made = null;
  class FakeWindow {
    constructor() { this.destroyed = false; this.handlers = {}; this.webContents = { send: channel => sent.push(channel), mainFrame: {} }; made = this; }
    once(name, fn) { this.handlers[name] = fn; }
    on(name, fn) { this.handlers[name] = fn; }
    isDestroyed() { return this.destroyed; }
    show() {} focus() {} loadFile() {}
    // Electron semantics: 'close' may veto, 'closed' follows only when it did not.
    close() {
      if (this.destroyed) return;
      let vetoed = false;
      this.handlers.close?.({ preventDefault() { vetoed = true; } });
      if (vetoed) return;
      this.destroyed = true; this.handlers.closed?.();
    }
  }
  const ipc = new Map();
  const ipcMain = { handle: (channel, fn) => ipc.set(channel, fn), removeHandler: channel => ipc.delete(channel) };
  let phase = 'in-call';
  const abandons = [];
  const hangUps = [];
  const service = {
    onState() {}, onEvent() {}, onReplayUpdated() {},
    getState: () => ({ phase, callId: 'call-1' }),
    start: async () => ({ phase: 'ringing', callId: 'call-1' }),
    hangUp: async options => { hangUps.push(options); phase = 'replay'; return { phase }; },
    abandon: async () => { abandons.push(1); return { phase: 'replay' }; },
  };
  createPracticeCallController({
    BrowserWindow: FakeWindow, ipcMain, isAuthorizedOwner: () => true, userDataPath: tmp,
    store: { readRecord: async callId => ({ callId, nodeId: 'n1' }) }, service,
  });
  await ipc.get('practice-call:start')({}, { nodeId: 'n1' });
  made.close();
  assert.equal(made.destroyed, false, 'the first close is held back');
  assert.equal(sent.includes('practice-call-window:leave-requested'), true, 'the window is asked to show its leave dialog');
  assert.equal(abandons.length, 0);
  await ipc.get('practice-call-window:hang-up')({}, { feedback: false });
  assert.deepEqual(hangUps, [{ feedback: false }]);
  assert.equal(made.destroyed, true, 'leaving without feedback closes the window');
});

test('a full start never sends POST or DELETE to the voices API', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-no-write-'));
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method ?? 'GET' });
    if (new URL(String(url)).pathname === '/v1/shared-voices') return { ok: true, status: 200, json: async () => ({ voices: [SHARED_LIBRARY_ROW], total_count: 3427 }) };
    return { ok: true, status: 200, json: async () => ({ tier: 'paid' }) };
  };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    fetch: fetchImpl, catalog: recordingCatalog(ACCOUNT_VOICES), random: () => 0,
    // The real draw against a recording fetch: every request it makes is a read.
    voiceLibrary: { ...realPoolStore, drawVoice: options => drawVoice(options) },
  } });
  const service = createPracticeCallService(deps);
  const state = await service.start(ARGS);
  assert.equal(state.phase, 'ringing');
  assert.equal(requests.some(request => new URL(request.url).pathname === '/v1/shared-voices'), true, 'the draw read the shared library');
  assert.deepEqual(requests.filter(request => request.method !== 'GET'), []);
  assert.deepEqual(requests.filter(request => new URL(request.url).pathname.startsWith('/v1/voices')), []);
});

test('an unreadable pool and a failing save never block the call', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-pool-fail-'));
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(String(reason && reason.message));
  const draws = [];
  const catalog = recordingCatalog(ACCOUNT_VOICES);
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    catalog, random: () => 0,
    voiceLibrary: {
      createVoicePoolStore: () => ({ load: async () => { throw new Error('unreadable pool file'); }, save: async () => { throw new Error('disk full'); } }),
      drawVoice: async options => {
        draws.push(options);
        return { voice: DRAWN_LIBRARY_VOICE, source: 'library', libraryTotal: 3427, attempts: 1 };
      },
    },
  } });
  const service = createPracticeCallService(deps);
  process.on('unhandledRejection', onUnhandled);
  let state;
  try {
    state = await service.start(ARGS);
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(state.phase, 'ringing');
  assert.deepEqual(draws[0].excludeVoiceIds, [], 'an unreadable pool excludes nothing');
  assert.equal(catalog.picks[0].voices[0].voiceId, 'lib-1');
  assert.deepEqual(catalog.listings, []);
  assert.deepEqual(unhandled, []);
});



// --- review fixes: warm sessions, history, ear data, clock, speaking, notices, replay entry ---

const flush = () => new Promise(resolve => setTimeout(resolve, 5));
async function liveCall(overrides = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-fix-'));
  const harness = makeDeps({ tmp, modelReady: true, ...overrides });
  const service = createPracticeCallService(harness.deps);
  return { tmp, service, ...harness };
}

test('a finished call closes its warm Claude sessions', async () => {
  const closed = [];
  const make = name => ({ start: async () => {}, close: async () => { closed.push(name); } });
  const names = ['opener', 'main', 'classifier'];
  let next = 0;
  const { service } = await liveCall({ deps: { sessionsFactory: () => make(names[next++]) } });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  await flush();
  assert.deepEqual(closed.sort(), ['classifier', 'main', 'opener']);
});

test('the interviewer is given the candidate name from the career snapshot, and a missing name never stops the call', async () => {
  const run = async loadCandidateName => {
    const seen = [];
    const asked = [];
    const warned = [];
    let restart;
    const { service } = await liveCall({ deps: {
      sessionsFactory: () => ({ start: async () => {}, close() {} }),
      engineFactory: options => {
        restart = options.restartSession;
        return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
      },
      loadCandidateName: async args => { asked.push(args); return loadCandidateName(args); },
      logger: { warn: message => warned.push(message) },
      prompts: {
        buildOpenerInstructions: () => 'OPENER\nReply only READY now.',
        buildInterviewerInstructions: options => { seen.push(options.candidateName); return 'MAIN\nReply only READY now.'; },
      },
    } });
    const state = await service.start(ARGS);
    await service.answer();
    const before = seen.length;
    await restart('main', { transcriptText: 'Candidate: hi' });
    assert.equal(seen.length > before, true, 'the restarted interviewer prompt was built');
    return { seen, asked, warned, state };
  };
  const named = await run(async () => '  Synthetic Person  ');
  assert.equal(named.state.phase, 'ringing');
  assert.deepEqual(named.asked.map(args => args.snapshotId), [ARGS.snapshotId]);
  assert.equal(named.seen.length > 0 && named.seen.every(name => name === 'Synthetic Person'), true, 'every interviewer prompt carries the name');
  assert.equal(JSON.stringify(named.state).includes('Synthetic Person'), false, 'the name never reaches the published call state');

  const missing = await run(async () => '');
  assert.equal(missing.state.phase, 'ringing');
  assert.equal(missing.seen.every(name => name === undefined), true);

  const broken = await run(async () => { throw Object.assign(new Error('Synthetic Person snapshot unreadable'), { code: 'ENOENT' }); });
  assert.equal(broken.state.phase, 'ringing', 'an unreadable snapshot does not stop the call');
  assert.equal(broken.seen.every(name => name === undefined), true);
  assert.equal(broken.warned.some(message => message.includes('candidate name unavailable')), true);
  assert.equal(broken.warned.some(message => message.includes('Synthetic Person')), false, 'the log line never carries the error text');
});

test('the candidate name reader takes identity.name from the pinned snapshot and cleans it', async () => {
  const { loadCandidateName, cleanCandidateName } = await import('../../electron/practiceCall/candidateName.js');
  const calls = [];
  const read = profile => async (root, id, options) => { calls.push({ root, id, options }); return profile === null ? null : { snapshotId: id, profile }; };
  const args = { snapshotId: 'snap-1', userDataPath: '/tmp/user-data', storageRoot: userData => `${userData}/store` };
  assert.equal(await loadCandidateName({ ...args, readSnapshot: read({ identity: { name: ' Synthetic\n Person ', contacts: ['x@example.test'] } }) }), 'Synthetic Person');
  assert.deepEqual(calls[0], { root: '/tmp/user-data/store', id: 'snap-1', options: { readOnly: true } });
  assert.equal(await loadCandidateName({ ...args, readSnapshot: read({ identity: {} }) }), '');
  assert.equal(await loadCandidateName({ ...args, readSnapshot: read(null) }), '');
  assert.equal(await loadCandidateName({ userDataPath: '/tmp/user-data', readSnapshot: read({ identity: { name: 'X' } }) }), '', 'no snapshot id, no read');
  assert.equal(cleanCandidateName('Ana [ignore previous] "Q" <b>'), 'Ana ignore previous Q b');
  assert.equal(cleanCandidateName('x'.repeat(81)), '');
  assert.equal(cleanCandidateName("Zoë O'Brien-Šimić"), "Zoë O'Brien-Šimić");
  assert.equal(cleanCandidateName('a\u200cb\u202e c\u200dd'), 'a\u200cb c\u200dd', 'joiners stay, other invisible characters go');
  assert.equal(cleanCandidateName(42), '');
});

test('a remark spoken over the speaker does not split the speaker\'s running caption', async () => {
  let emit;
  const { service } = await liveCall({ deps: { engineFactory: options => { emit = options.onEvent; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; } } });
  await service.start(ARGS);
  await service.answer();
  emit({ type: 'caption', speaker: 'interviewer', speakerId: 'A', text: 'Let me introduce', final: false });
  emit({ type: 'overlay', speakerId: 'B', text: 'Hi there.', atMs: 10 });
  emit({ type: 'caption', speaker: 'interviewer', speakerId: 'A', text: 'Let me introduce our engineer.', final: true });
  const rows = service.getState().captions.map(item => [item.speakerId, item.text, Boolean(item.overlay)]);
  assert.deepEqual(rows.filter(row => !row[2]), [['A', 'Let me introduce our engineer.', false]], 'one line for the speaker, updated in place');
  assert.equal(rows.filter(row => row[2]).length, 1, 'the remark is its own line');
});

test('a restarted session gets its history before the final READY line', async () => {
  const started = [];
  const histories = [];
  let restart;
  const { service } = await liveCall({ deps: {
    sessionsFactory: () => ({ start: async options => { started.push(options.instructions); }, close() {} }),
    prompts: {
      buildOpenerInstructions: options => { histories.push(['opener', options.history]); return `OPENER\nReply only READY now.`; },
      buildInterviewerInstructions: options => { histories.push(['main', options.history]); return `MAIN\nReply only READY now.`; },
    },
    engineFactory: options => {
      restart = options.restartSession;
      return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  started.length = 0;
  histories.length = 0;
  await restart('main', { transcriptText: 'Candidate: hi' });
  await restart('opener', { transcriptText: 'Candidate: hi' });
  assert.deepEqual(histories, [['main', 'Candidate: hi'], ['opener', 'Candidate: hi']]);
  await restart('classifier', { transcriptText: 'Candidate: hi' });
  const classifier = started.at(-1);
  assert.equal(classifier.trimEnd().endsWith('Reply only READY now.'), true);
  assert.equal(classifier.indexOf('Candidate: hi') < classifier.lastIndexOf('Reply only READY'), true);
  await restart('main');
  assert.equal(started.at(-1), 'MAIN\nReply only READY now.');
});

test('the record holds tone samples, candidate prosody and the voice baseline, and noteSpeech gets a word count', async () => {
  const noted = [];
  let helperEvent;
  const prosody = [{ startMs: 1, endMs: 2, speechMs: 1, wordsPerMinute: 120 }];
  const baseline = { wordsPerMinute: 130 };
  const { service, deps } = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
    earFactory: options => ({
      noteSpeech: async span => { noted.push(span); options.onToneSample({ atMs: 5, endMs: 9, arousal: 0.1, dominance: 0.2, valence: 0.3 }); },
      settle: async () => {}, prosodyTurns: () => prosody, baselineSnapshot: () => baseline, close() {},
    }),
  } });
  await service.start(ARGS);
  await service.answer();
  helperEvent({ type: 'transcript', final: true, startMs: 100, endMs: 900, text: ' one two  three ' });
  await flush();
  await service.hangUp();
  assert.deepEqual(noted, [{ startMs: 100, endMs: 900, wordCount: 3 }]);
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.toneSamples.map(item => item.atMs), [5]);
  assert.deepEqual(record.candidateProsody, prosody);
  assert.deepEqual(record.voiceBaseline, baseline);
});

test('the call clock starts at answer and the record keeps the recording lead', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const finalized = [];
  const { service, deps } = await liveCall({ deps: {
    clock,
    trackFactory: () => ({ started() {}, ended() {}, addUtterance() {}, finalize: async (file, options) => { finalized.push(options.durationMs); } }),
    // The tracks cannot be cut here (there are no files), so the mix keeps its 4 s lead.
    mixdown: async () => ({ durationMs: 9000 }),
  } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.startedAt, 14000);
  assert.equal(record.durationMs, 9000, 'the replay length is the length of the recording the times sit on');
  assert.equal(record.recordingLeadMs, 4000);
  assert.deepEqual(finalized, [9000], 'the interviewer track covers the helper timeline');
  assert.equal(record.timings.precheckMs, 0);
});

test('the interviewer playing lights the speaking marker and candidate voice activity cannot overwrite it', async () => {
  let helperEvent;
  const { service, engine } = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'phase', phase: 'playing' });
  assert.equal(service.getState().speaking, 'interviewer');
  helperEvent({ type: 'vad', speaking: true });
  helperEvent({ type: 'vad', speaking: false });
  assert.equal(service.getState().speaking, 'interviewer');
  engine()({ type: 'phase', phase: 'listening' });
  assert.equal(service.getState().speaking, null);
  helperEvent({ type: 'vad', speaking: true });
  assert.equal(service.getState().speaking, 'candidate');
  engine()({ type: 'phase', phase: 'committed' });
  assert.equal(service.getState().speaking, 'candidate');
});

test('engine voice errors show a notice that clears when the next reply plays', async () => {
  const { service, engine } = await liveCall();
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'error', code: 'voice-failed' });
  assert.equal(service.getState().notice.code, 'voice-failed');
  assert.equal(service.getState().notice.message.length > 0, true);
  engine()({ type: 'phase', phase: 'playing' });
  assert.equal(service.getState().notice, null);
});

test('the playback mirror opens no segment at call time zero', async () => {
  const started = [];
  let audio;
  const { service } = await liveCall({ deps: {
    trackFactory: () => ({ started: (id, atMs) => started.push([id, atMs]), ended() {}, addUtterance() {}, finalize: async () => {} }),
    engineFactory: options => { audio = options.audio; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  await service.start(ARGS);
  await service.answer();
  audio.play('u1', 24000);
  assert.deepEqual(started, []);
});

test('a call with no real candidate turn skips transcription and review', async () => {
  let transcribed = 0;
  let analysed = 0;
  const { service, deps } = await liveCall({ deps: {
    transcribe: async () => { transcribed += 1; return {}; },
    analyze: async () => { analysed += 1; return { status: 'ready', feedback: { summary: 'x' } }; },
    engineFactory: () => ({
      start() {}, hangUp() {},
      state: () => ({ transcript: [
        { speaker: 'interviewer', text: 'Hi', startMs: 0, endMs: 1 },
        { speaker: 'candidate', text: 'mm-hm', acknowledgement: true, startMs: 1, endMs: 2 },
      ], elapsedMs: 100 }),
    }),
  } });
  await service.start(ARGS);
  await service.answer();
  const state = await service.hangUp();
  assert.equal(state.phase, 'replay');
  assert.equal(transcribed, 0);
  assert.equal(analysed, 0);
  const analysis = await deps.store.readAnalysis('call-1');
  assert.equal(analysis.status, 'ready');
  assert.equal(analysis.tooShort, true);
  assert.equal(analysis.feedback, undefined);
  assert.equal((await service.getReplay('call-1')).analysis.tooShort, true);
});

test('a rejected practice registry result raises feedback-error', async () => {
  const errors = [];
  const registry = { arm: async () => 'session-1', cancel() {}, finish: async () => ({ status: 'rejected', note: 'bad' }) };
  const { service } = await liveCall({ deps: { registry } });
  service.onEvent(event => { if (event.kind === 'feedback-error') errors.push(event); });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  assert.equal(errors.length, 1);
});

test('a helper error before the call is answered ends in an error state, a decline ends quietly', async () => {
  const errored = await liveCall({ helperError: true });
  const states = [];
  errored.service.onState(state => states.push(state));
  await errored.service.start(ARGS);
  await new Promise(resolve => setTimeout(resolve, 30));
  const state = errored.service.getState();
  assert.equal(state.phase, 'error');
  assert.equal(state.error.message.length > 0, true);
  assert.equal(await errored.deps.store.readRecord('call-1'), null);
  const quiet = await liveCall();
  await quiet.service.start(ARGS);
  assert.equal((await quiet.service.hangUp()).phase, 'replay');
});

test('a running caption hypothesis replaces the one before it', async () => {
  const { service, engine } = await liveCall();
  await service.start(ARGS);
  await service.answer();
  engine()({ type: 'caption', speaker: 'interviewer', text: 'Tell', final: false });
  engine()({ type: 'caption', speaker: 'interviewer', text: 'Tell me', final: false });
  assert.deepEqual(service.getState().captions, [{ speaker: 'interviewer', text: 'Tell me', final: false }]);
  engine()({ type: 'caption', speaker: 'interviewer', text: 'Tell me more.', final: true });
  engine()({ type: 'caption', speaker: 'interviewer', text: 'Next', final: false });
  assert.deepEqual(service.getState().captions.map(item => item.text), ['Tell me more.', 'Next']);
});

test('model download progress is cumulative over both models and names the current one', async () => {
  const seen = [];
  const { tmp, service } = await startOf({ modelReady: false, deps: {
    modelStore: () => ({
      status: () => ({ smartTurn: 'missing', tone: 'missing', sizes: { smartTurn: 30, tone: 70 } }),
      ensure: async (name, { onProgress }) => {
        const size = name === 'smartTurn' ? 30 : 70;
        onProgress?.({ receivedBytes: size / 2, totalBytes: size });
        onProgress?.({ receivedBytes: size, totalBytes: size });
      },
      pathOf: name => path.join(tmp, 'practice-models', `${name}.onnx`),
    }),
  } });
  service.onState(state => { if (state.phase === 'downloading' && state.modelDownload) seen.push(state.modelDownload); });
  await service.start(ARGS);
  await service.agreeModelDownload();
  const bars = seen.map(item => [item.name, item.receivedBytes, item.totalBytes]);
  assert.deepEqual(bars.at(-1), ['tone', 100, 100]);
  assert.equal(bars.some(item => item[0] === 'tone' && item[1] === 30 && item[2] === 100), true, 'the bar does not drop to zero');
  assert.equal(bars.some(item => item[0] === 'smartTurn' && item[1] === 15), true);
  for (let i = 1; i < bars.length; i += 1) assert.equal(bars[i][1] >= bars[i - 1][1], true);
});

test('chat is ignored once the interviewer has left', async () => {
  const typed = [];
  const { service, engine } = await liveCall({ deps: {
    engineFactory: options => {
      engine.listener = options.onEvent;
      return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }), typed: text => typed.push(text) };
    },
  } });
  await service.start(ARGS);
  await service.answer();
  service.sendChat('before');
  engine.listener({ type: 'ended', reason: 'interviewer' });
  const state = service.sendChat('after');
  assert.deepEqual(state.chat.map(item => item.text), ['before']);
  assert.deepEqual(typed, ['before']);
});

test('showReplay enters the replay phase for a call and is refused while a call is live', async () => {
  const idle = await liveCall();
  const state = idle.service.showReplay('call-9');
  assert.equal(state.phase, 'replay');
  assert.equal(state.callId, 'call-9');
  assert.equal(idle.service.getState().callId, 'call-9');
  const live = await liveCall();
  await live.service.start(ARGS);
  await live.service.answer();
  const refused = live.service.showReplay('call-9');
  assert.equal(refused.phase, 'in-call');
  assert.equal(live.service.getState().callId, 'call-1');
});

// The packaged app is one bundle: the bundler follows `import('literal')` and leaves
// `import(variable)` as a runtime read of a source file the app does not ship. That made
// every practice call fail to start in the built app while all tests passed from source.
test('every dynamic import in the call code names its module literally', async () => {
  const fsSync = await import('node:fs');
  const pathModule = await import('node:path');
  const roots = ['electron/practiceCall', 'electron/interviewPracticeCallEngine.js', 'electron/interviewPracticeTransport.js', 'electron/interviewPracticeAudio.js'];
  const files = [];
  const walk = target => {
    if (fsSync.statSync(target).isDirectory()) { for (const name of fsSync.readdirSync(target)) walk(pathModule.join(target, name)); return; }
    if (target.endsWith('.js')) files.push(target);
  };
  for (const root of roots) walk(root);
  assert.ok(files.length > 20, 'the call code was found');
  const offenders = [];
  for (const file of files) {
    const source = fsSync.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bimport\(\s*([^)\s][^)]*)\)/gu)) {
      const specifier = match[1].trim();
      if (!/^(['"])[^'"`$]+\1$/u.test(specifier)) offenders.push(`${file}: import(${specifier})`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Seen in the first run of the built app: the audio helper failed a second after starting,
// the teardown closed the sessions that were still starting, their start was rejected with
// CANCELLED, and the window showed "CANCELLED" instead of the microphone message.
test('a helper error during session start keeps its own message, not the cancelled start', async () => {
  let fireHelperError = () => {};
  const rejectors = [];
  const errored = await liveCall({ deps: {
    helperFactory: ({ onEvent }) => {
      fireHelperError = () => onEvent({ type: 'error', code: 'capture-failed' });
      return { start: async () => ({ ok: true }), stop: async () => {}, play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {} };
    },
    sessionsFactory: () => ({
      // The helper fails while the sessions are still starting.
      start: () => new Promise((resolve, reject) => { rejectors.push(reject); if (rejectors.length === 1) setTimeout(fireHelperError, 0); }),
      close: async () => { for (const reject of rejectors) reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' })); },
    }),
  } });
  // The hub shows whatever start returns, so that value must not carry the cancelled start either.
  const returned = await errored.service.start(ARGS);
  assert.notEqual(returned.error?.code, 'precheck-failed');
  assert.doesNotMatch(String(returned.error?.message ?? ''), /CANCELLED/u);
  await new Promise(resolve => setTimeout(resolve, 30));
  const state = errored.service.getState();
  assert.equal(state.phase, 'error');
  assert.notEqual(state.error.code, 'precheck-failed');
  assert.doesNotMatch(state.error.message, /CANCELLED/u);
});

// Seen in the first call made in the built app: the replay's first line sat at 0:28 and the
// audio ran 25 s longer than the call length shown, because the recording starts during setup.
test('the saved call is on the call clock: the lead is cut from both tracks and every time moves back by it', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const trims = [];
  const { service, deps } = await liveCall({ deps: {
    clock,
    trimStart: async request => { trims.push({ files: request.paths.map(file => path.basename(file)), startMs: request.startMs }); },
    earFactory: () => ({
      noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [],
      prosodyTurns: () => [{ startMs: 6000, endMs: 8000, pauses: [{ startMs: 6500, endMs: 7000 }], wordsPerMinute: 150 }],
      baselineSnapshot: () => null, close() {},
    }),
    engineFactory: () => ({
      start() {}, hangUp() {},
      state: () => ({ elapsedMs: 5000, transcript: [
        { speaker: 'interviewer', text: 'Hello.', startMs: 4500, endMs: 5500 },
        { speaker: 'candidate', text: 'Hi.', startMs: 6000, endMs: 8000 },
        { speaker: 'candidate', channel: 'chat', text: 'typed', startMs: 3000, endMs: 3000 },
      ] }),
    }),
  } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(trims, [{ files: ['candidate.wav', 'interviewer.wav'], startMs: 4000 }]);
  assert.equal(record.recordingLeadMs, 0, 'the saved recording has no lead left');
  assert.equal(record.timings.setupLeadMs, 4000);
  assert.deepEqual(record.transcript.map(turn => [turn.startMs, turn.endMs]), [[500, 1500], [2000, 4000], [0, 0]], 'times count from the answer and never go below zero');
  assert.deepEqual(record.candidateProsody[0].pauses, [{ startMs: 2500, endMs: 3000 }]);
  assert.equal(record.candidateProsody[0].wordsPerMinute, 150, 'only time fields move');
});

// Seen in the first call made in the built app: a question was asked but never answered, so its
// score was empty. The review accepted that, but storing the same feedback validated it again
// and refused it, and the session the call had armed stayed armed and blocked later calls.
test('feedback that passed validation once passes again, and a refused save never leaves the session armed', async () => {
  const { validatePracticeFeedback } = await import('../../electron/ipc/interviewQaPractice.js');
  const once = validatePracticeFeedback({
    overall: { score: 6, summary: 'Ended early.' },
    planned: [{ question: 'Walk me through a project.', asked: true }, { question: 'Why us?', asked: false }],
    moments: [{ kind: 'small-talk', prompt: 'How is your day?' }],
    priorities: ['Answer the follow-up.'],
  });
  assert.equal(once.planned[0].score, null);
  assert.deepEqual(validatePracticeFeedback(once), once);

  const log = [];
  const registry = {
    arm: async () => { log.push('arm'); return 'session-1'; },
    cancel: nodeId => { log.push(`cancel:${nodeId}`); },
    finish: () => { log.push('finish'); return { status: 'rejected', note: 'not accepted' }; },
  };
  const errors = [];
  const { service } = await startOf({ deps: { registry, analyze: async () => ({ status: 'ready', chapters: [], feedback: { summary: 'solid', callId: null } }) } });
  service.onEvent(event => { if (event.kind === 'feedback-error') errors.push(event); });
  await service.start(ARGS);
  await service.answer();
  await service.hangUp();
  assert.deepEqual(log, ['arm', 'finish', 'cancel:node-1']);
  assert.equal(errors.length, 1);
});

// Seen in the built app: the helper's recording clock starts when capture starts, about 2.5 s
// after the helper is launched, so a lead counted from the launch cut 2.5 s too much.
test('the recording lead is read off the helper clock, not counted from the helper launch', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  let helperEvent;
  const trims = [];
  const { service } = await liveCall({ deps: {
    clock,
    trimStart: async request => { trims.push(request.startMs); },
    helperFactory: ({ onEvent }) => {
      helperEvent = onEvent;
      return { start: async () => ({ ok: true }), play() {}, pushAudio() {}, endUtterance() {}, cancel() {}, mute() {}, stop: async () => { onEvent({ type: 'recording', state: 'closed' }); } };
    },
  } });
  await service.start(ARGS);
  // Capture began 2.5 s after the launch: at clock 13500 the helper says 1000 ms have been recorded.
  now = 13500;
  helperEvent({ type: 'level', rms: 0, atMs: 1000 });
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  assert.deepEqual(trims, [1500], 'the answer falls 1.5 s into the recording, not 4 s');
});

// --- panel calls: a lead plus up to two colleagues ------------------------------

const PANEL_VOICES = Object.freeze({
  'lib-1': 'Nora Lead', 'lib-2': 'Ben Specialist', 'lib-3': 'Cara Second', 'lib-4': 'Dana Third', 'lib-5': 'Eli Fourth',
});
const panelVoice = voiceId => ({ ...DRAWN_LIBRARY_VOICE, voiceId, voiceName: PANEL_VOICES[voiceId] });

/** A clock whose timers only run when a test fires them. */
function manualClock() {
  const timers = [];
  let at = 1000;
  return {
    timers, setNow(value) { at = value; },
    now: () => at,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, fired: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    fire(timer) { if (!timer.cleared && !timer.fired) { timer.fired = true; timer.fn(); } },
    pending: () => timers.filter(timer => !timer.cleared && !timer.fired),
    lateTimers: () => timers.filter(timer => timer.ms >= 40000 && timer.ms <= 210000),
  };
}

/**
 * Everything a panel start needs: distinct drawn voices, a planner stand-in that seats `cast` (entries name a
 * drawn voice key such as 'V2'), a recording prompt module and a recording engine. `plan` replaces the whole plan.
 */
function panelHarness({ cast = [{ voice: 'V2', role: 'Senior Engineer', focus: 'system design' }], plan, random = () => 0.1, drawFails = [], silent = [], deps = {}, voices = ['lib-1', 'lib-2', 'lib-3'] } = {}) {
  const draws = [];
  const built = [];
  const starts = [];
  const engineOptions = [];
  const engineCalls = [];
  const factoryOptions = [];
  const clock = manualClock();
  const harness = voiceHarness({ audio: true });
  const make = options => {
    const factory = harness.make(options);
    if (silent.includes(options.voiceId)) {
      const open = factory.open;
      factory.open = openOptions => { const stream = open(openOptions); stream.finish = async () => {}; return stream; };
    }
    return factory;
  };
  const planner = fakePlanner(drawn => (plan ? plan(drawn) : soloPlan(drawn, {
    panel: cast.filter(member => drawn.some(voice => voice.key === member.voice)).map(member => ({ stability: 0.3, room: 0.4, manner: 'Plain.', ...member })),
  })));
  let made = 0;
  const overrides = {
    clock, random, planCall: planner,
    prompts: {
      buildOpenerInstructions: options => { built.push({ kind: 'opener', options }); return 'opener'; },
      buildInterviewerInstructions: options => { built.push({ kind: 'main', options }); return 'interviewer'; },
    },
    voiceLibrary: {
      ...realPoolStore,
      drawVoice: async options => {
        draws.push(options);
        if (drawFails.includes(draws.length)) throw new Error('library unreachable');
        return { voice: panelVoice(voices[Math.min(draws.length - 1, voices.length - 1)]), source: 'library', libraryTotal: 3427, attempts: 1 };
      },
    },
    catalog: { pickPersonaVoice: options => ({ voiceId: options.voices[0].voiceId, name: PANEL_VOICES[options.voices[0].voiceId] }) },
    voiceFactory: options => { factoryOptions.push(options); return make(options); },
    sessionsFactory: () => {
      const kind = ['opener', 'main', 'classifier'][made++ % 3];
      return { start: async ({ instructions }) => { starts.push({ kind, instructions }); return { reply: 'READY' }; } };
    },
    panelVoiceFactory: options => ({ panelOf: options, open() { throw new Error('not opened here'); } }),
    engineFactory: options => {
      engineOptions.push(options);
      return {
        start() {}, hangUp() { engineCalls.push('hangup'); }, helperEvent() {}, typed() {},
        participantJoined: id => engineCalls.push(`joined:${id}`),
        state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000 }),
      };
    },
    ...deps,
  };
  return { overrides, clock, draws, built, starts, engineOptions, engineCalls, factoryOptions, planner };
}

const panelStart = async (setup, extra = {}) => {
  const started = await startOf({ modelReady: true, deps: setup.overrides, ...extra });
  const state = await started.service.start(ARGS);
  return { ...started, state };
};

test('panel: five distinct voices are drawn, each avoiding the others and the newest voice, and the planner is offered all of them', async () => {
  const setup = panelHarness({ voices: ['lib-1', 'lib-2', 'lib-3', 'lib-4', 'lib-5'] });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-panel-draw-'));
  await writeFile(poolFilePath(tmp), JSON.stringify({ version: 1, lastUsed: { 'lib-9': 900 } }));
  const built = makeDeps({ tmp, modelReady: true, deps: setup.overrides });
  const service = createPracticeCallService(built.deps);
  const state = await service.start(ARGS);
  assert.equal(state.phase, 'ringing');
  assert.equal(setup.draws.length, 5, 'the lead and four more');
  assert.deepEqual(setup.draws[0].excludeVoiceIds, ['lib-9']);
  assert.deepEqual(setup.draws[1].excludeVoiceIds.sort(), ['lib-1', 'lib-9']);
  assert.deepEqual(setup.draws[2].excludeVoiceIds.sort(), ['lib-1', 'lib-2', 'lib-9']);
  assert.deepEqual(setup.draws[4].excludeVoiceIds.sort(), ['lib-1', 'lib-2', 'lib-3', 'lib-4', 'lib-9']);
  assert.equal(setup.planner.calls.length, 1, 'planned once');
  assert.deepEqual(setup.planner.calls[0].voices.map(voice => [voice.key, voice.name]),
    [['V1', 'Nora Lead'], ['V2', 'Ben Specialist'], ['V3', 'Cara Second'], ['V4', 'Dana Third'], ['V5', 'Eli Fourth']]);
  for (const voice of setup.planner.calls[0].voices) assert.deepEqual(Object.keys(voice).sort(), ['accent', 'age', 'description', 'gender', 'key', 'name'], 'no voice id reaches the planner');
  // Nothing is made for a voice the plan did not choose: the lead and the one colleague only.
  assert.deepEqual(setup.factoryOptions.map(item => item.voiceId), ['lib-1', 'lib-2']);
});

test('panel: the plan\'s colleagues settle with ids, names, roles and manner, and every session is built once from them', async () => {
  const setup = panelHarness({ random: () => 0.1 });
  const { state } = await panelStart(setup);
  assert.equal(state.phase, 'ringing');
  const mains = setup.built.filter(item => item.kind === 'main');
  assert.equal(setup.starts.filter(item => item.kind === 'main').length, 1, 'the main session starts once');
  assert.equal(mains.length, 1);
  assert.equal('colleagues' in mains[0].options, false, 'nobody is asked to cast');
  assert.deepEqual(mains[0].options.panel.map(item => [item.id, item.name, item.role, item.focus, item.joins]), [['B', 'Ben Specialist', 'Senior Engineer', 'system design', 'late']]);
  const opener = setup.built.find(item => item.kind === 'opener');
  assert.deepEqual(opener.options.panel, mains[0].options.panel);
  const callPlan = mains[0].options.callPlan;
  assert.equal(callPlan.interviewKind, 'A short screening conversation.');
  assert.equal('lead' in callPlan || 'panel' in callPlan, false, 'the plan names its people, not a lead and a panel');
  assert.deepEqual(callPlan.people.map(item => [item.id, item.name, item.role, item.focus, item.manner]),
    [['A', 'Nora Lead', 'Hiring Manager', '', 'Even and direct.'], ['B', 'Ben Specialist', 'Senior Engineer', 'system design', 'Plain.']]);
  assert.equal(callPlan.people[0].temperament, 'neutral');
  assert.equal(Boolean(callPlan.people[0].voice), true);
  assert.deepEqual(callPlan.people[1].joins === 'late' || callPlan.people[1].joins === 'start', true);
  assert.equal(Boolean(callPlan.people[1].voice), true);
  assert.deepEqual(callPlan.questions, [{ number: 1, askedBy: 'A', minutes: 10, probes: [] }]);
  assert.deepEqual(callPlan.problems, []);
  assert.deepEqual(mains[0].options.picked, [1]);
  assert.equal(state.persona.name, 'Nora Lead');
  assert.equal(state.persona.role, 'Hiring Manager', 'the role is known before the call rings');
  assert.deepEqual(state.participants.map(item => [item.id, item.status]), [['A', 'joined']], 'a late colleague is not shown yet');
});

test('panel: a high random draw starts colleagues at the call start', async () => {
  const setup = panelHarness({ random: () => 0.9, cast: [{ voice: 'V2', role: 'Engineer', focus: '' }] });
  const { state } = await panelStart(setup);
  assert.deepEqual(setup.built.find(item => item.kind === 'main').options.panel.map(item => item.joins), ['start']);
  assert.deepEqual(state.participants.map(item => item.id), ['A', 'B'], 'a colleague who starts with the call is shown at once');
});

test('panel: a plan with colleagues builds the panel voice and tells the engine who is present', async () => {
  const setup = panelHarness({ random: () => 0.9, cast: [{ voice: 'V2', role: 'Engineer', focus: 'api' }, { voice: 'V3', role: 'Director', focus: '' }] });
  const { service } = await panelStart(setup);
  await service.answer();
  const options = setup.engineOptions[0];
  assert.deepEqual(Object.keys(options.voice.panelOf.factories), ['A', 'B', 'C']);
  assert.equal(options.voice.panelOf.leadId, 'A');
  assert.equal(options.voice.panelOf.factories.B.options.voiceId, 'lib-2');
  assert.equal(options.voice.panelOf.factories.C.options.voiceId, 'lib-3');
  assert.deepEqual(options.panel, { leadId: 'A', speakers: [
    { id: 'A', name: 'Nora Lead', present: true, joined: true }, { id: 'B', name: 'Ben Specialist', present: true, joined: true }, { id: 'C', name: 'Cara Second', present: true, joined: true },
  ] });
  await service.hangUp();
});

test('panel: a plan with no colleagues keeps the call solo', async () => {
  const setup = panelHarness({ cast: [] });
  const { service, state } = await panelStart(setup);
  assert.equal(state.phase, 'ringing');
  await service.answer();
  const options = setup.engineOptions[0];
  assert.equal('panel' in options, false, 'the engine gets no panel');
  assert.deepEqual(Object.keys(options.voice.panelOf.factories), ['A'], 'a panel voice with the lead alone');
  assert.equal(options.voice.panelOf.leadId, 'A');
  assert.deepEqual(service.getState().participants.map(item => item.id), ['A']);
  assert.equal(setup.clock.lateTimers().length, 0, 'no join timer');
  const main = setup.built.find(item => item.kind === 'main');
  assert.deepEqual(main.options.panel, []);
  assert.deepEqual(main.options.callPlan.people.map(item => item.id), ['A']);
  assert.deepEqual(setup.factoryOptions.map(item => item.voiceId), ['lib-1'], 'only the lead is made');
  await service.hangUp();
});

test('panel: the lead may be any drawn voice, and only the chosen voices are made and warmed', async () => {
  const setup = panelHarness({
    voices: ['lib-1', 'lib-2', 'lib-3', 'lib-4', 'lib-5'], random: () => 0.9,
    plan: drawn => soloPlan(drawn, {
      lead: { voice: 'V3', role: 'Engineering Manager', temperament: 'warm', stability: 0.4, room: 0.2, manner: 'Unhurried.' },
      panel: [{ voice: 'V1', role: 'Recruiter', focus: 'logistics', stability: 0.3, room: 0.6, manner: 'Brisk.' }, { voice: 'V5', role: 'Designer', focus: 'ux', stability: 0.5, room: 0.3, manner: 'Curious.' }],
      questions: [{ number: 1, askedBy: 'V3', minutes: 8, probes: [] }],
    }),
  });
  const { service, state } = await panelStart(setup);
  assert.equal(state.persona.name, 'Cara Second', 'the planned lead is the third drawn voice');
  assert.deepEqual(state.participants.map(item => [item.id, item.name]), [['A', 'Cara Second'], ['B', 'Nora Lead'], ['C', 'Eli Fourth']], 'colleagues take ids in plan order');
  assert.deepEqual(setup.factoryOptions.map(item => [item.voiceId, item.stability]), [['lib-3', 0.4], ['lib-1', 0.3], ['lib-5', 0.5]]);
  const warmed = voiceId => setup.factoryOptions.some(item => item.voiceId === voiceId);
  assert.equal(warmed('lib-2') || warmed('lib-4'), false, 'a drawn voice the plan did not use is never made or warmed');
  await service.answer();
  assert.deepEqual(Object.keys(setup.engineOptions[0].voice.panelOf.factories), ['A', 'B', 'C']);
  assert.equal(setup.engineOptions[0].voice.panelOf.factories.A.options.voiceId, 'lib-3');
  await service.hangUp();
});

test('panel: a failed extra draw, a repeated voice or a silent warm-up only means fewer colleagues', async () => {
  const failed = panelHarness({ drawFails: [2] });
  await panelStart(failed);
  assert.deepEqual(failed.planner.calls[0].voices.map(voice => [voice.key, voice.name]), [['V1', 'Nora Lead'], ['V2', 'Cara Second']], 'the voice that could not be drawn is simply not offered');
  assert.deepEqual(failed.built.find(item => item.kind === 'main').options.panel.map(item => [item.id, item.name]), [['B', 'Cara Second']],
    'the colleague who remains takes the first colleague id');

  // A chosen colleague whose voice does not answer is left off the call instead of speaking in the lead's voice.
  const silent = panelHarness({ silent: ['lib-2'] });
  const quiet = await panelStart(silent);
  assert.equal(silent.built.find(item => item.kind === 'main').options.panel.length, 1, 'the first build seats the planned colleague');
  assert.equal(quiet.state.phase, 'ringing');
  assert.deepEqual(silent.built.findLast(item => item.kind === 'opener').options.panel, [], 'a chosen voice that does not warm up is dropped');
  assert.equal(quiet.state.participants.length, 1);

  const repeated = panelHarness();
  repeated.overrides.voiceLibrary.drawVoice = async () => ({ voice: panelVoice('lib-1'), source: 'library', libraryTotal: 1, attempts: 1 });
  const solo = await panelStart(repeated);
  assert.equal(solo.state.phase, 'ringing');
  assert.deepEqual(repeated.planner.calls[0].voices.map(voice => voice.key), ['V1'], 'the lead voice drawn again is not offered a second time');
});

test('panel: a failed lead draw still fails the call', async () => {
  const setup = panelHarness({ drawFails: [1] });
  const { state } = await panelStart(setup);
  assert.equal(state.phase, 'error');
  assert.equal(state.error.code, 'voice-library-unavailable');
});

test('panel: a fixed temperament still wins over the plan and the plan\'s colleagues are still seated', async () => {
  const setup = panelHarness({ plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, temperament: 'warm' },
    panel: [{ voice: 'V2', role: 'Senior Engineer', focus: 'system design', stability: 0.3, room: 0.4, manner: 'Plain.' }],
  }) });
  const loadBrief = async args => {
    const loaded = await makeDeps({ tmp: '/unused' }).deps.loadBrief(args);
    return { ...loaded, practice: { temperament: 'tough' } };
  };
  const { state } = await panelStart(setup, { deps: { ...setup.overrides, loadBrief } });
  assert.equal(state.phase, 'ringing');
  assert.equal(state.persona.name, 'Nora Lead');
  const opener = setup.built.find(item => item.kind === 'opener');
  assert.equal(opener.options.persona.temperament, 'tough');
  assert.equal(opener.options.callPlan.people[0].temperament, 'tough', 'the plan the interviewer reads says the same');
  assert.equal(opener.options.panel.length, 1, 'the colleagues were seated although the temperament was fixed');
});

test('panel: a late colleague joins when the timer fires, once, and the record keeps the time', async () => {
  const setup = panelHarness({ random: () => 0.1 });
  const { service, deps } = await panelStart(setup);
  const events = [];
  service.onEvent(event => events.push(event));
  const states = [];
  service.onState(item => states.push(item));
  await service.answer();
  const late = setup.clock.lateTimers();
  assert.equal(late.length, 1, 'one timer for the one late colleague');
  assert.equal(late[0].ms >= 40000 && late[0].ms <= 210000, true);
  assert.equal(late[0].ms, 57000, 'uniform between 40 s and 210 s from the random draw');
  assert.deepEqual(service.getState().participants.map(item => item.id), ['A']);
  setup.clock.setNow(1000 + 57000);
  setup.clock.fire(late[0]);
  setup.clock.fire(late[0]);
  assert.deepEqual(service.getState().participants.map(item => [item.id, item.name, item.role, item.focus, item.status]), [
    ['A', 'Nora Lead', 'Hiring Manager', '', 'joined'], ['B', 'Ben Specialist', 'Senior Engineer', 'system design', 'joined'],
  ]);
  assert.deepEqual(events.filter(event => event.type === 'participant-joined'), [{ type: 'participant-joined', id: 'B', name: 'Ben Specialist', kind: 'participant-joined' }]);
  assert.deepEqual(setup.engineCalls, ['joined:B']);
  assert.equal(states.some(item => item.participants.length === 2), true, 'the join is published');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.panel, [{ id: 'B', name: 'Ben Specialist', role: 'Senior Engineer', focus: 'system design', joins: 'late', joinedAtMs: 57000, voiceId: 'lib-2', room: { seed: 'lib-2', rt60Ms: 300 }, roomAmount: 0.4, stability: 0.3 }]);
  assert.equal(record.persona.name, 'Nora Lead');
});

test('panel: a colleague who never joined has a null join time and every way a call ends clears the timers', async () => {
  for (const [label, end] of [
    ['hang up', service => service.hangUp()],
    ['abandon', service => service.abandon()],
    ['interviewer leaves', async (service, built, setup) => { setup.engineOptions[0].onEvent({ type: 'ended', reason: 'interviewer' }); }],
  ]) {
    const setup = panelHarness({ random: () => 0.1 });
    const built = await panelStart(setup);
    await built.service.answer();
    const timers = setup.clock.lateTimers();
    assert.equal(setup.clock.pending().filter(timer => timers.includes(timer)).length, 1, label);
    await end(built.service, built, setup);
    assert.equal(timers.every(timer => timer.cleared), true, `${label}: the join timer is cleared`);
    setup.clock.fire(timers[0]);
    assert.equal(built.service.getState().participants.some(item => item.id === 'B'), false, `${label}: a cleared timer joins nobody`);
    if (label === 'hang up') {
      const record = await built.deps.store.readRecord('call-1');
      assert.equal(record.panel[0].joinedAtMs, null);
    }
  }
});

test('panel: a late timer that fires after the interviewers left does not add anyone', async () => {
  const setup = panelHarness({ random: () => 0.1 });
  const built = await panelStart(setup);
  await built.service.answer();
  const [timer] = setup.clock.lateTimers();
  setup.engineOptions[0].onEvent({ type: 'ended', reason: 'interviewer' });
  // A clock that ignores clearTimeout must still not bring a colleague into an empty room.
  timer.cleared = false;
  setup.clock.fire(timer);
  assert.deepEqual(setup.engineCalls.filter(call => call.startsWith('joined')), []);
  assert.deepEqual(built.service.getState().participants.map(item => [item.id, item.status]), [['A', 'left']]);
});

test('panel: speaker events set speakingId, which clears when the interviewer stops playing', async () => {
  const setup = panelHarness({ random: () => 0.9 });
  const built = await panelStart(setup);
  await built.service.answer();
  const engine = setup.engineOptions[0].onEvent;
  engine({ type: 'phase', phase: 'playing' });
  engine({ type: 'speaker', speakerId: 'A' });
  assert.equal(built.service.getState().speakingId, 'A');
  engine({ type: 'speaker', speakerId: 'B' });
  assert.equal(built.service.getState().speakingId, 'B');
  engine({ type: 'phase', phase: 'listening' });
  assert.equal(built.service.getState().speakingId, null);
  engine({ type: 'speaker', speakerId: 'B' });
  engine({ type: 'ended', reason: 'interviewer' });
  assert.equal(built.service.getState().speakingId, null);
  assert.equal(built.service.getState().participants.every(item => item.status === 'left'), true, 'every participant leaves with the interviewers');
});

test('panel: a caption keeps the speaker id the engine gives it', async () => {
  const setup = panelHarness({ random: () => 0.9 });
  const built = await panelStart(setup);
  await built.service.answer();
  setup.engineOptions[0].onEvent({ type: 'caption', speaker: 'interviewer', speakerId: 'B', text: 'Hello', final: true });
  assert.equal(built.service.getState().captions.at(-1).speakerId, 'B');
});

test('solo: a default call is unchanged and records an empty panel', async () => {
  const built = await startOf({ modelReady: true });
  const state = await built.service.start(ARGS);
  assert.deepEqual(state.participants.map(item => [item.id, item.name, item.status]), [['A', 'Ada Lovelace', 'joined']]);
  assert.equal(state.speakingId, null);
  await built.service.answer();
  await built.service.hangUp();
  const record = await built.deps.store.readRecord('call-1');
  assert.deepEqual(record.panel, []);
  assert.equal(record.persona.voiceId, 'v1');
});

// Measured 2026-11-17: the acknowledgement on Opus took about 3.4 s to its first word, later than
// the reply it is meant to come before. With its own small instructions Haiku does it in 0.65 s.
test('the acknowledgement session runs on Haiku at low effort, the reply and the classifier on Opus, also after a restart', async () => {
  const made = [];
  let restart;
  const { service } = await liveCall({ deps: {
    sessionsFactory: config => { made.push(config); return { start: async () => ({ reply: 'READY' }), close() {} }; },
    engineFactory: options => { restart = options.restartSession; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  await service.start(ARGS);
  await service.answer();
  assert.deepEqual(made, [{ model: 'haiku', effort: 'low' }, { model: 'opus', effort: 'low' }, { model: 'opus', effort: 'low' }]);
  await restart('opener', {});
  await restart('main', {});
  assert.deepEqual(made.slice(3), [{ model: 'haiku', effort: 'low' }, { model: 'opus', effort: 'low' }]);
});

// Seen in the built app: the lead and her colleague were both called Cohen.
test('panel: a colleague never shares a first name or a surname with someone already on the call', async () => {
  const setup = panelHarness({ cast: [{ voice: 'V2', role: 'Engineer', focus: '' }, { voice: 'V3', role: 'Designer', focus: '' }] });
  // The first name drawn for each colleague repeats the lead's surname; the next draw is free.
  const offered = { 'lib-2': ['Ben Lead', 'Ben Specialist'], 'lib-3': ['Nora Second', 'Cara Second'] };
  setup.overrides.catalog = { pickPersonaVoice: options => {
    const voiceId = options.voices[0].voiceId;
    const queue = offered[voiceId];
    return { voiceId, name: queue ? (queue.length > 1 ? queue.shift() : queue[0]) : PANEL_VOICES[voiceId] };
  } };
  await panelStart(setup);
  assert.deepEqual(setup.planner.calls[0].voices.map(voice => voice.name), ['Nora Lead', 'Ben Specialist', 'Cara Second'], 'the planner is offered only distinct names');
  assert.deepEqual(setup.built.find(item => item.kind === 'main').options.panel.map(item => item.name), ['Ben Specialist', 'Cara Second']);
});

// A latent fault found in review: the engine adopts whatever restartSession returns as the new
// session. It was handed the whole sessions map, so the turn after any restart had nothing to call.
test('restartSession returns the new session itself, the one the engine will then use', async () => {
  let restart;
  const made = [];
  const { service } = await liveCall({ deps: {
    sessionsFactory: () => { const session = { start: async () => ({ reply: 'READY' }), turn: async () => ({ text: 'ok' }), close() {} }; made.push(session); return session; },
    engineFactory: options => { restart = options.restartSession; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  await service.start(ARGS);
  await service.answer();
  for (const kind of ['main', 'opener', 'classifier']) {
    const next = await restart(kind, { transcriptText: 'Candidate: hi' });
    assert.equal(next, made.at(-1), `${kind}: the returned value is the session just started`);
    assert.equal(typeof next.turn, 'function');
  }
});

// A chosen colleague whose voice will not warm up is left off the call. The lead's session was started
// with them in the cast and would hand over to someone who cannot speak, so a fresh one replaces it.
test('panel: when a chosen colleague cannot speak, a fresh lead starts from the cast as it now is and their questions pass to the lead', async () => {
  const setup = panelHarness({ silent: ['lib-2'], plan: drawn => soloPlan(drawn, {
    panel: [{ voice: 'V2', role: 'Engineer', focus: 'api', stability: 0.3, room: 0.4, manner: 'Plain.' }],
    questions: [{ number: 1, askedBy: 'V1', minutes: 5, probes: [] }, { number: 2, askedBy: 'V2', minutes: 5, probes: ['a vague number'] }],
  }) });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const { state, service, deps } = await panelStart(setup);
  assert.equal(state.phase, 'ringing');
  const mains = setup.built.filter(item => item.kind === 'main');
  assert.equal(setup.starts.length, 5, 'the three sessions, then a fresh lead and a fresh acknowledgement session');
  assert.deepEqual(mains[0].options.callPlan.questions.map(item => [item.number, item.askedBy]), [[1, 'A'], [2, 'B']], 'the first lead session was given the colleague');
  assert.deepEqual(mains.at(-1).options.panel, [], 'the replacement is built with nobody else on the call');
  assert.deepEqual(mains.at(-1).options.callPlan.people.map(item => item.id), ['A']);
  assert.deepEqual(mains.at(-1).options.callPlan.questions.map(item => [item.number, item.askedBy]), [[1, 'A'], [2, 'A']], 'their question is the lead\'s now');
  assert.equal('colleagues' in mains.at(-1).options, false);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.panel, []);
  const dropped = record.setup.voices.find(voice => voice.key === 'V2');
  assert.deepEqual([dropped.used, dropped.dropped, dropped.id], [false, true, null], 'the record says the drawn voice was not used');
});

// Quitting the app (or asking again) while a call is already being saved must wait for that save.
test('hanging up again while the call is being finished waits for the same finish', async () => {
  let releaseMix;
  const { service, deps } = await liveCall({ deps: { mixdown: () => new Promise(resolve => { releaseMix = () => resolve({ durationMs: 4000 }); }) } });
  await service.start(ARGS);
  await service.answer();
  const first = service.hangUp({ feedback: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  let secondDone = false;
  const second = service.hangUp({ feedback: false }).then(state => { secondDone = true; return state; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(secondDone, false, 'the second call is still waiting on the first');
  releaseMix();
  assert.equal((await first).phase, 'replay');
  assert.equal((await second).phase, 'replay');
  assert.ok(await deps.store.readRecord('call-1'));
});

// The owner's rule (2026-11-17): no built-in ElevenLabs voice is ever an interviewer. The pool is
// the shared library, but four built-in voices are also published there under the same names.
test('every voice draw skips the built-in voices by id and by name, for the lead and for colleagues', async () => {
  const setup = panelHarness();
  setup.overrides.voiceLibrary.listBuiltInVoices = async () => ({ voiceIds: ['premade-1'], names: ['brian - deep, resonant and comforting'] });
  await panelStart(setup);
  assert.ok(setup.draws.length >= 2, 'the lead and at least one colleague were drawn');
  for (const draw of setup.draws) {
    assert.ok(draw.excludeVoiceIds.includes('premade-1'));
    assert.deepEqual(draw.excludeNames, ['brian - deep, resonant and comforting']);
  }

  // The list being unreadable does not cost the call its voice.
  const offline = panelHarness();
  offline.overrides.voiceLibrary.listBuiltInVoices = async () => { throw new Error('offline'); };
  const { state } = await panelStart(offline);
  assert.equal(state.phase, 'ringing');
});

test('stability: the plan\'s numbers reach the lead\'s and each colleague\'s voice and the record', async () => {
  const setup = panelHarness({ random: () => 0.9, plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, stability: 0.45 },
    panel: [{ voice: 'V2', role: 'Senior Engineer', focus: 'api', stability: 0.55, room: 0.4, manner: 'Plain.' }],
  }) });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  assert.equal(factories.A.options.stability, 0.45, 'the lead');
  assert.equal(factories.A.options.voiceId, 'lib-1');
  assert.equal(factories.B.options.stability, 0.55, 'the colleague');
  assert.equal(factories.B.options.voiceId, 'lib-2');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.stability, 0.45);
  assert.equal(record.persona.stabilityFrom, 'plan');
  assert.equal(record.panel[0].stability, 0.55);
});

test('stability: a lead or colleague with no usable number falls back to the default, and a fixed temperament still takes the plan\'s number', async () => {
  const setup = panelHarness({ random: () => 0.9, plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, stability: null },
    panel: [{ voice: 'V2', role: 'Engineer', focus: '', stability: Number.NaN, room: 0.4, manner: 'Plain.' }],
  }) });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  assert.equal(factories.A.options.stability, 0.3);
  assert.equal(factories.B.options.stability, 0.3);
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.stabilityFrom, 'fallback');
  assert.equal(record.panel[0].stability, 0.3);

  const harness = voiceHarness({ audio: true });
  const loadBrief = async args => {
    const loaded = await makeDeps({ tmp: '/unused' }).deps.loadBrief(args);
    return { ...loaded, practice: { temperament: 'tough' } };
  };
  const fixed = await startOf({ deps: {
    loadBrief, voiceFactory: harness.make,
    planCall: fakePlanner(voices => soloPlan(voices, { lead: { ...soloPlan(voices).lead, stability: 0.5 } })),
  } });
  await fixed.service.start({ ...ARGS });
  assert.equal(harness.factories.at(-1).options.stability, 0.5);
  await fixed.service.answer();
  await fixed.service.hangUp();
  const kept = (await fixed.deps.store.readRecord('call-1')).persona;
  assert.deepEqual([kept.stabilityFrom, kept.temperament, kept.temperamentFrom], ['plan', 'tough', 'request']);
});

// --- the lead's own role, the picked questions and the question history ----------

/** A prompt module that records every build. */
function recordingPrompts() {
  const built = [];
  return {
    built,
    prompts: {
      buildOpenerInstructions: options => { built.push({ kind: 'opener', options }); return 'opener'; },
      buildInterviewerInstructions: options => { built.push({ kind: 'main', options }); return 'interviewer'; },
    },
  };
}
const PLAN_CARDS = [
  { id: 'q1', question: 'Tell me about a launch.', answer: 'I led one.' },
  { id: 'q2', question: 'Describe a conflict.', answer: 'We talked.' },
  { id: 'q3', question: 'Why this team?', answer: 'The mission.' },
];
const askedEngine = asked => options => ({
  start() { options.onEvent({ type: 'phase', phase: 'listening' }); }, hangUp() {}, helperEvent() {}, typed() {},
  state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000, ...(asked === undefined ? {} : { askedQuestions: asked }) }),
});

test('role: the lead\'s own role and the picked questions come from the plan on every path, never random', async () => {
  const fixedTemperament = async args => ({ ...(await makeDeps({ tmp: '/unused' }).deps.loadBrief(args)), practice: { temperament: 'tough' } });
  for (const [label, extra] of [['planned temperament', {}], ['fixed temperament', { loadBrief: fixedTemperament }]]) {
    const harness = recordingPrompts();
    const planner = fakePlanner(voices => soloPlan(voices, {
      lead: { ...soloPlan(voices).lead, role: 'Staff Engineer' },
      questions: [{ number: 2, askedBy: voices[0].key, minutes: 6, probes: [] }, { number: 1, askedBy: voices[0].key, minutes: 4, probes: [] }],
    }));
    const { service, deps } = await startOf({ deps: { prompts: harness.prompts, planCall: planner, loadCards: async () => PLAN_CARDS, ...extra } });
    const states = [];
    service.onState(item => states.push(item));
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'ringing', label);
    assert.equal(state.persona.role, 'Staff Engineer', label);
    assert.equal(state.participants[0].role, 'Staff Engineer', label);
    assert.deepEqual(planner.calls[0].pool.map(item => [item.number, item.question, item.timesAsked]), [
      [1, 'Tell me about a launch.', 0], [2, 'Describe a conflict.', 0], [3, 'Why this team?', 0],
    ], `${label}: the planner is given the whole prepared pool by number`);
    assert.equal(harness.built.length, 2, `${label}: each prompt is built once`);
    for (const item of harness.built) {
      assert.equal(item.options.persona.role, 'Staff Engineer', `${label}: ${item.kind} knows the role at its first build`);
      assert.deepEqual(item.options.picked, [2, 1], label);
    }
    assert.equal(states.filter(item => item.phase === 'ringing').every(item => item.persona.role === 'Staff Engineer'), true, `${label}: never rings with an empty role`);
    await service.answer();
    await service.hangUp({ feedback: false });
    const record = await deps.store.readRecord('call-1');
    assert.equal(record.persona.role, 'Staff Engineer', label);
    assert.deepEqual(record.pickedQuestions, [2, 1], label);
    assert.equal((await service.getReplay('call-1')).persona.role, 'Staff Engineer', label);
  }
});

test('role: the settled role, picked questions and plan reach restart prompts, the acknowledgement session included', async () => {
  const setup = panelHarness({ plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, role: 'Engineering Director' },
    panel: [{ voice: 'V2', role: 'Engineer', focus: 'api', stability: 0.3, room: 0.4, manner: 'Plain.' }],
    questions: [{ number: 3, askedBy: 'V1', minutes: 6, probes: ['the missing result'] }, { number: 1, askedBy: 'V2', minutes: 4, probes: [] }],
    problems: [{ ref: 'p1', question: 1, language: 'javascript', parts: [{ title: 'Task', content: 'Reverse a list.' }], solution: 'return list.reverse();', edgeCases: ['empty list'], hints: ['think about order'] }],
  }) });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  let restart;
  const inner = setup.overrides.engineFactory;
  setup.overrides.engineFactory = options => { restart = options.restartSession; return inner(options); };
  const { service } = await panelStart(setup);
  await service.answer();
  await restart('main', { transcriptText: 'earlier talk' });
  const again = setup.built.filter(item => item.kind === 'main').at(-1);
  assert.equal(again.options.persona.role, 'Engineering Director');
  assert.deepEqual(again.options.picked, [3, 1]);
  assert.equal(again.options.history, 'earlier talk');
  assert.equal(again.options.callPlan.interviewKind, 'A short screening conversation.');
  assert.deepEqual(again.options.callPlan.questions.map(item => [item.number, item.askedBy, item.probes]), [[3, 'A', ['the missing result']], [1, 'B', []]]);
  assert.deepEqual(again.options.callPlan.problems.map(item => [item.ref, item.solution, item.hints]), [['p1', 'return list.reverse();', ['think about order']]], 'the private problem notes ride along');
  await restart('opener', { transcriptText: 'earlier talk' });
  const opener = setup.built.filter(item => item.kind === 'opener').at(-1);
  assert.deepEqual(opener.options.picked, [3, 1]);
  assert.equal(opener.options.callPlan.people[1].name, 'Ben Specialist');
});

test('history: timesAsked reaches the prompt options and a failing read never stops the call', async () => {
  const history = memoryHistory({ 'node-1': { q1: 2, q3: 1 } });
  const harness = recordingPrompts();
  const { service } = await startOf({ deps: { prompts: harness.prompts, loadCards: async () => PLAN_CARDS, questionHistory: history } });
  await service.start(ARGS);
  assert.deepEqual(harness.built.find(item => item.kind === 'main').options.plan.map(item => item.timesAsked), [2, 0, 1]);

  const warnings = [];
  const broken = { counts: async () => { throw new Error('disk gone'); }, record: async () => { throw new Error('disk gone'); } };
  const second = recordingPrompts();
  const failing = await startOf({ deps: { prompts: second.prompts, loadCards: async () => PLAN_CARDS, questionHistory: broken, logger: { warn: message => warnings.push(message) } } });
  const state = await failing.service.start(ARGS);
  assert.equal(state.phase, 'ringing');
  assert.deepEqual(second.built.find(item => item.kind === 'main').options.plan.map(item => item.timesAsked), [0, 0, 0]);
  assert.equal(warnings.some(text => text.includes('question history unavailable')), true);
  await failing.service.answer();
  const ended = await failing.service.hangUp({ feedback: false });
  assert.equal(ended.phase, 'replay', 'a history write failure does not fail the hang-up');
});

test('history: asked questions are recorded at hang-up with or without feedback, and not for an unanswered call', async () => {
  for (const feedback of [true, false]) {
    const history = memoryHistory();
    const { service, deps } = await startOf({ deps: { loadCards: async () => PLAN_CARDS, questionHistory: history, engineFactory: askedEngine([3, 1]) } });
    await service.start(ARGS);
    await service.answer();
    await service.hangUp({ feedback });
    assert.deepEqual(history.recorded, [{ nodeId: 'node-1', ids: ['q3', 'q1'] }], `feedback ${feedback}`);
    const record = await deps.store.readRecord('call-1');
    assert.deepEqual(record.askedQuestions, [3, 1]);
    assert.deepEqual(record.askedQuestionIds, ['q3', 'q1']);
  }
  // An engine that does not report the list yet reads as nothing asked, and records nothing.
  const quiet = memoryHistory();
  const old = await startOf({ deps: { loadCards: async () => PLAN_CARDS, questionHistory: quiet, engineFactory: askedEngine(undefined) } });
  await old.service.start(ARGS);
  await old.service.answer();
  await old.service.hangUp({ feedback: false });
  assert.deepEqual(quiet.recorded, []);
  assert.deepEqual((await old.deps.store.readRecord('call-1')).askedQuestions, []);

  const never = memoryHistory();
  const declined = await startOf({ deps: { loadCards: async () => PLAN_CARDS, questionHistory: never, engineFactory: askedEngine([1]) } });
  await declined.service.start(ARGS);
  await declined.service.hangUp();
  assert.deepEqual(never.recorded, [], 'a call that was never answered records nothing');
});

test('question history store: counts, atomic save, tolerant load and a bound of 200 jobs', async () => {
  const { createQuestionHistory } = await import('../../electron/practiceCall/questionHistory.js');
  const files = new Map();
  const modes = [];
  const memFs = {
    async readFile(file) { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
    async mkdir() {},
    async writeFile(file, data, options) { modes.push({ file, mode: options?.mode }); files.set(file, data); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const file = '/mem/history.json';
  const history = createQuestionHistory({ filePath: file, fs: memFs });
  assert.deepEqual(await history.counts('job-a'), {}, 'a missing file reads as empty');
  await history.record('job-a', ['q1', 'q2', 'q1']);
  await history.record('job-a', ['q1']);
  assert.deepEqual(await history.counts('job-a'), { q1: 2, q2: 1 }, 'one per distinct id per call');
  assert.deepEqual(await history.counts('job-b'), {});
  assert.equal(modes.every(item => item.mode === 0o600 && item.file !== file), true, 'written to a temp file with mode 0600, then renamed');
  assert.deepEqual([...files.keys()], [file], 'no temp file is left behind');
  files.set(file, '{not json');
  assert.deepEqual(await history.counts('job-a'), {}, 'a malformed file reads as empty');
  files.set(file, JSON.stringify({ version: 1, jobs: { 'job-a': { counts: { q1: 'x', q2: 3, q3: -1 }, updatedAt: 1 } } }));
  assert.deepEqual(await history.counts('job-a'), { q2: 3 }, 'bad counts are dropped');
  files.delete(file);
  for (let at = 0; at < 205; at += 1) await history.record(`job-${at}`, ['q1']);
  assert.equal(Object.keys(JSON.parse(files.get(file)).jobs).length, 200);
  assert.deepEqual(await history.counts('job-0'), {}, 'the least recently updated job was dropped');
  assert.deepEqual(await history.counts('job-204'), { q1: 1 });
  await history.record('job-5', ['q9']);
  assert.deepEqual(await history.counts('job-5'), { q1: 1, q9: 1 }, 'an update keeps its job as the most recent one');
});

// The shared screen and the coding pad: published state, forwarding to the engine, and the saved record.
function padEngine(log, state = { transcript: [], elapsedMs: 5000 }) {
  const box = {};
  box.factory = options => {
    box.emit = options.onEvent;
    return {
      start() {}, hangUp() {}, typed() {}, state: () => state,
      setPadText: text => log.push(['setPadText', text]),
    };
  };
  return box;
}

test('the shared screen and the pad appear in the published state with the presenter name', async () => {
  const log = [];
  const box = padEngine(log);
  const { service } = await liveCall({ deps: { engineFactory: box.factory } });
  await service.start(ARGS);
  await service.answer();
  const first = service.getState();
  assert.equal(first.screen, null);
  assert.deepEqual(first.pad, { open: false, lang: '', text: '' });
  box.emit({ type: 'screen', title: 'Two sum', content: 'Find a pair.', speakerId: 'A', atMs: 1000 });
  const shown = service.getState().screen;
  assert.deepEqual({ title: shown.title, content: shown.content, speakerId: shown.speakerId }, { title: 'Two sum', content: 'Find a pair.', speakerId: 'A' });
  assert.equal(typeof shown.presenterName, 'string');
  assert.ok(shown.presenterName.length > 0, 'the lead is named');
  box.emit({ type: 'pad', open: true, lang: 'python', atMs: 1100 });
  assert.deepEqual(service.getState().pad, { open: true, lang: 'python', text: '' });
  box.emit({ type: 'screen-stop', atMs: 2000 });
  assert.equal(service.getState().screen, null);
  box.emit({ type: 'pad', open: false, atMs: 2100 });
  assert.equal(service.getState().pad.open, false);
});

test('updatePad stores and forwards text without publishing, and is ignored when closed, absent or after the interviewer left', async () => {
  const log = [];
  const box = padEngine(log);
  const { service } = await liveCall({ deps: { engineFactory: box.factory } });
  assert.doesNotThrow(() => service.updatePad('nobody'), 'ignored with no call');
  await service.start(ARGS);
  await service.answer();
  service.updatePad('closed pad');
  assert.deepEqual(log, [], 'a closed pad forwards nothing');
  box.emit({ type: 'pad', open: true, lang: 'js' });
  let published = 0;
  service.onState(() => { published += 1; });
  service.updatePad('x = 1');
  assert.equal(published, 0, 'typing never publishes to listeners');
  assert.equal(service.getState().pad.text, 'x = 1');
  service.updatePad('y'.repeat(30000));
  assert.equal(service.getState().pad.text.length, 20000);
  service.updatePad('x = 2');
  assert.deepEqual(log.slice(-1), [['setPadText', 'x = 2']]);
  assert.equal(service.submitPad, undefined, 'there is no Ready: the interviewer watches the pad');
  const before = log.length;
  box.emit({ type: 'ended', reason: 'interviewer' });
  service.updatePad('late');
  assert.equal(log.length, before, 'nothing after the interviewer left');
});

test('the record holds screens and pad snapshots on the call clock, closed at replacement, stop and hang-up', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const log = [];
  const box = padEngine(log, { transcript: [{ speaker: 'candidate', text: 'Hi.', startMs: 6000, endMs: 8000 }], elapsedMs: 5000 });
  const { service, deps } = await liveCall({ deps: { clock, trimStart: async () => {}, engineFactory: box.factory } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  box.emit({ type: 'screen', title: 'One', content: 'First part.', speakerId: 'A', atMs: 5000 });
  box.emit({ type: 'pad', open: true, lang: 'python', atMs: 5100 });
  box.emit({ type: 'screen', title: 'Two', content: 'Second part.', speakerId: 'A', atMs: 7000 });
  service.updatePad('def f(): pass');
  service.sendChat('done');
  service.sendChat('again');
  service.updatePad('def f(): return 1');
  box.emit({ type: 'pad-sent', atMs: 9000 });
  now = 19000;
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.timings.setupLeadMs, 4000);
  assert.deepEqual(record.screens.map(item => [item.title, item.atMs, item.endMs]), [['One', 1000, 3000], ['Two', 3000, 5000]], 'shifted by the trimmed lead; the last closes at hang-up');
  assert.equal(record.screens[0].speakerId, 'A');
  assert.equal(record.pad.lang, 'python');
  assert.deepEqual(record.pad.snapshots.map(item => item.text), ['def f(): pass', 'def f(): return 1'], 'one snapshot per change');
  assert.ok(record.pad.snapshots.every(item => Number.isFinite(item.atMs) && item.atMs >= 0));
  const replay = await service.getReplay('call-1');
  assert.deepEqual(replay.screens, record.screens);
  assert.deepEqual(replay.pad, record.pad);
});

// A share takes a few seconds to come up: the clock below fires timers on demand.
function timerClock(start = 10000) {
  const c = { t: start, timers: [] };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const h = { fn, at: c.t + ms, live: true }; c.timers.push(h); return h; };
  c.clearTimeout = h => { if (h) h.live = false; };
  c.advance = ms => {
    c.t += ms;
    for (const h of c.timers.filter(x => x.live && x.at <= c.t)) { h.live = false; h.fn(); }
  };
  return c;
}
async function delayedCall() {
  const clock = timerClock();
  const box = padEngine([]);
  const live = await liveCall({ deps: { clock, trimStart: async () => {}, engineFactory: box.factory } });
  await live.service.start(ARGS);
  await live.service.answer();
  return { ...live, clock, box };
}

test('a delayed share is pending, then shown after the delay with the record time of its appearance', async () => {
  const { service, deps, clock, box } = await delayedCall();
  box.emit({ type: 'screen', title: 'One', content: 'First.', speakerId: 'A', delayMs: 3000 });
  let s = service.getState();
  assert.equal(s.screen, null);
  assert.equal(s.sharing.speakerId, 'A');
  assert.equal(s.sharing.title, null);
  assert.ok(s.sharing.presenterName.length > 0);
  clock.advance(2900);
  assert.equal(service.getState().screen, null);
  clock.advance(200);
  s = service.getState();
  assert.equal(s.sharing, null);
  assert.equal(s.screen.title, 'One');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.screens.length, 1);
  assert.ok(record.screens[0].atMs >= 3000 && record.screens[0].atMs <= 3200, 'at the appearance, not the tag');
});

test('a newer screen replaces a pending one and keeps the old content visible until it arrives', async () => {
  const { service, clock, box } = await delayedCall();
  box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 1000 });
  clock.advance(1000);
  box.emit({ type: 'screen', title: 'Two', content: 'b', speakerId: 'A', delayMs: 2000 });
  assert.equal(service.getState().screen.title, 'One');
  assert.ok(service.getState().sharing);
  clock.advance(1000);
  box.emit({ type: 'screen', title: 'Three', content: 'c', speakerId: 'A', delayMs: 2000 });
  clock.advance(1500);
  assert.equal(service.getState().screen.title, 'One', 'the replaced pending share never appears');
  clock.advance(600);
  assert.equal(service.getState().screen.title, 'Three');
  assert.equal(service.getState().sharing, null);
});

test('screen-stop, the interviewer leaving and hang-up cancel a pending share', async () => {
  const stopped = await delayedCall();
  stopped.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 2000 });
  stopped.box.emit({ type: 'screen-stop' });
  assert.equal(stopped.service.getState().sharing, null);
  stopped.clock.advance(5000);
  assert.equal(stopped.service.getState().screen, null);

  const left = await delayedCall();
  left.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 2000 });
  left.box.emit({ type: 'ended', reason: 'interviewer' });
  assert.equal(left.service.getState().sharing, null);
  left.clock.advance(5000);
  assert.equal(left.service.getState().screen, null);

  const hung = await delayedCall();
  hung.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 2000 });
  await hung.service.hangUp();
  hung.clock.advance(5000);
  assert.equal(hung.service.getState().screen, null);
});

test('a pad open waits for a pending share and is immediate otherwise', async () => {
  const waits = await delayedCall();
  waits.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 3000 });
  waits.box.emit({ type: 'pad', open: true, lang: 'python' });
  assert.equal(waits.service.getState().pad.open, false);
  waits.clock.advance(3000);
  assert.equal(waits.service.getState().pad.open, true);
  assert.equal(waits.service.getState().pad.lang, 'python');
  assert.ok(waits.service.getState().screen);

  const free = await delayedCall();
  free.box.emit({ type: 'pad', open: true, lang: 'js' });
  assert.equal(free.service.getState().pad.open, true);

  const cancelled = await delayedCall();
  cancelled.box.emit({ type: 'screen', title: 'One', content: 'a', speakerId: 'A', delayMs: 3000 });
  cancelled.box.emit({ type: 'pad', open: true, lang: 'js' });
  cancelled.box.emit({ type: 'screen-stop' });
  assert.equal(cancelled.service.getState().pad.open, true, 'a cancelled share releases the held pad');
});

test('screen-stop closes the open screen entry and a call without screens saves empty lists', async () => {
  const box = padEngine([]);
  const { service, deps } = await liveCall({ deps: { engineFactory: box.factory } });
  await service.start(ARGS);
  await service.answer();
  box.emit({ type: 'screen', title: 'A', content: 'a', speakerId: 'A', atMs: 100 });
  box.emit({ type: 'screen-stop', atMs: 400 });
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.screens.map(item => [item.atMs, item.endMs]), [[100, 400]]);
  const quiet = await liveCall({ deps: { engineFactory: padEngine([]).factory } });
  await quiet.service.start(ARGS);
  await quiet.service.answer();
  await quiet.service.hangUp();
  const empty = await quiet.deps.store.readRecord('call-1');
  assert.deepEqual(empty.screens, []);
  assert.deepEqual(empty.pad, { lang: '', snapshots: [] });
});

test('the review receives the record with screens and pad', async () => {
  const box = padEngine([], { transcript: [{ speaker: 'candidate', text: 'Hi.', startMs: 1, endMs: 2 }], elapsedMs: 5000 });
  let seen = null;
  const { service } = await liveCall({ deps: {
    engineFactory: box.factory,
    analyze: async input => { seen = input.callRecord; return { status: 'ready', chapters: [], feedback: { summary: 'ok' } }; },
  } });
  await service.start(ARGS);
  await service.answer();
  box.emit({ type: 'screen', title: 'T', content: 'c', speakerId: 'A', atMs: 10 });
  await service.hangUp();
  assert.equal(seen.screens.length, 1);
  assert.deepEqual(seen.pad, { lang: '', snapshots: [] });
});

test('overlay: an overlaid remark rings its interviewer, captions it once, and clears after its estimated length', async () => {
  const setup = panelHarness({ random: () => 0.9 });
  const built = await panelStart(setup);
  await built.service.answer();
  const engine = setup.engineOptions[0].onEvent;
  engine({ type: 'phase', phase: 'playing' });
  engine({ type: 'speaker', speakerId: 'A' });
  engine({ type: 'overlay', speakerId: 'B', text: 'Hi Jack.', atMs: 1200 });
  let state = built.service.getState();
  assert.equal(state.speakingId, 'A', 'the main speaker keeps the ring');
  assert.equal(state.overSpeakingId, 'B');
  assert.deepEqual(state.captions.filter(item => item.overlay).map(item => [item.speakerId, item.text]), [['B', 'Hi Jack.']]);
  // The engine's own caption for the same remark does not add a second row.
  engine({ type: 'caption', speaker: 'interviewer', speakerId: 'B', text: 'Hi Jack.', final: true });
  assert.equal(built.service.getState().captions.filter(item => item.text === 'Hi Jack.').length, 1);
  const timer = setup.clock.pending().find(item => item.ms === 700);
  assert.ok(timer, 'two words last 700 ms');
  setup.clock.fire(timer);
  assert.equal(built.service.getState().overSpeakingId, null);
  engine({ type: 'overlay', speakerId: 'C', text: 'one two three four five six seven eight', atMs: 5000 });
  assert.ok(setup.clock.pending().some(item => item.ms === 2800));
  engine({ type: 'phase', phase: 'listening' });
  assert.equal(built.service.getState().overSpeakingId, null, 'the remark ends with the speaking state');
});

test('overlay: the transcript entry reaches the record with speakerId and overlay, shifted like other entries', async () => {
  let now = 10000;
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout: () => {} };
  const log = [];
  const transcript = [
    { speaker: 'interviewer', speakerId: 'A', text: 'Let me introduce Sam.', startMs: 6000, endMs: 9000 },
    { speaker: 'interviewer', speakerId: 'B', text: 'Hi Jack.', startMs: 7000, endMs: 7700, overlay: true },
  ];
  const box = padEngine(log, { transcript, elapsedMs: 5000 });
  const { service, deps } = await liveCall({ deps: { clock, trimStart: async () => {}, engineFactory: box.factory } });
  await service.start(ARGS);
  now = 14000;
  await service.answer();
  now = 19000;
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  const entry = record.transcript.find(item => item.overlay);
  assert.deepEqual([entry.speakerId, entry.text, entry.startMs, entry.endMs], ['B', 'Hi Jack.', 3000, 3700]);
  const replay = await service.getReplay('call-1');
  assert.equal(replay.transcript.find(item => item.overlay)?.speakerId, 'B');
});

test('while paused sendChat does nothing, updatePad still works, and chat is accepted after the engine reports resumed', async () => {
  const log = [];
  const box = padEngine(log);
  const typedLog = [];
  const factory = options => { const e = box.factory(options); e.typed = text => typedLog.push(text); return e; };
  const { service } = await liveCall({ deps: { engineFactory: factory } });
  await service.start(ARGS);
  await service.answer();
  box.emit({ type: 'pad', open: true, lang: 'js' });
  box.emit({ type: 'paused', paused: true });
  assert.equal(service.getState().paused, true);
  const before = service.getState().chat.length;
  const state = service.sendChat('held back');
  assert.equal(state.chat.length, before, 'the chat list does not gain the message');
  assert.deepEqual(typedLog, []);
  service.updatePad('draft code');
  assert.deepEqual(log, [['setPadText', 'draft code']]);
  box.emit({ type: 'paused', paused: false });
  service.sendChat('now sent');
  assert.deepEqual(typedLog, ['now sent']);
});

// Per-interviewer room: the fake processor stamps every sample byte with the room's tag, so the audio
// shows which room treated it.
const roomDeps = extra => ({
  callRoom: seed => ({ seed, tag: seed.charCodeAt(seed.length - 1) }),
  callSound: ({ room }) => ({ process: buffer => Buffer.alloc(buffer.length, room.tag), reset() {} }),
  ...extra,
});
const heardFrom = (factory, utteranceId) => {
  const stream = factory.open({ utteranceId });
  let heard = null;
  stream.onAudio(chunk => { heard = chunk; });
  stream.audioListener(Buffer.from([1, 0, 2, 0, 3]));
  return heard;
};

test('the lead and a colleague are treated in different rooms from their voice ids, and the record keeps both rooms', async () => {
  const cast = [{ voice: 'V2', role: 'Senior Engineer', focus: 'api', stability: 0.55 }];
  const setup = panelHarness({ random: () => 0.9, cast, deps: roomDeps() });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  const lead = heardFrom(factories.A, 'u1');
  const colleague = heardFrom(factories.B, 'u2');
  assert.equal(lead.length, 5, 'odd byte counts keep their length');
  assert.deepEqual([...lead], Array(5).fill('1'.charCodeAt(0)), 'lib-1 room');
  assert.deepEqual([...colleague], Array(5).fill('2'.charCodeAt(0)), 'lib-2 room');
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.room.seed, 'lib-1');
  assert.equal(record.panel[0].room.seed, 'lib-2');
  assert.notDeepEqual(record.persona.room, record.panel[0].room);
});

test('the warm-up line is never treated', async () => {
  const setup = panelHarness({ random: () => 0.9, cast: [], deps: roomDeps() });
  const { service } = await panelStart(setup);
  await service.answer();
  const lead = setup.engineOptions[0].voice;
  const heard = heardFrom(lead.panelOf ? lead.panelOf.factories.A : lead, 'warm-up');
  assert.deepEqual([...heard], [1, 0, 2, 0, 3]);
});

test('a throwing room processor leaves the audio untouched and warns once', async () => {
  const warnings = [];
  const cast = [{ voice: 'V2', role: 'Engineer', focus: '', stability: 0.5 }];
  const setup = panelHarness({ random: () => 0.9, cast, deps: roomDeps({
    callSound: () => ({ process: () => { throw new Error('processor broke'); }, reset() {} }),
    logger: { warn: message => warnings.push(message), info() {}, error() {} },
  }) });
  const { service } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  assert.deepEqual([...heardFrom(factories.A, 'u1')], [1, 0, 2, 0, 3]);
  assert.deepEqual([...heardFrom(factories.B, 'u2')], [1, 0, 2, 0, 3]);
  assert.equal(warnings.length, 1);
});

// Chosen room amounts: the plan's numbers reach roomFor, the treated audio and the record.
const amountRooms = extra => ({
  callRoom: (seed, amount) => ({ seed, amount, tag: seed.charCodeAt(seed.length - 1) }),
  callSound: ({ room }) => ({ process: buffer => Buffer.alloc(buffer.length, room.tag), reset() {} }),
  ...extra,
});

test('the lead and a colleague amounts reach roomFor, the treated audio and the record', async () => {
  const setup = panelHarness({ random: () => 0.9, deps: amountRooms(), plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, room: 0.2 },
    panel: [{ voice: 'V2', role: 'Engineer', focus: '', stability: 0.5, room: 0.8, manner: 'Plain.' }],
  }) });
  const calls = [];
  const roomFor = setup.overrides.callRoom;
  setup.overrides.callRoom = (seed, amount) => { calls.push([seed, amount ?? null]); return roomFor(seed, amount); };
  const { service, deps } = await panelStart(setup);
  await service.answer();
  const factories = setup.engineOptions[0].voice.panelOf.factories;
  assert.equal(heardFrom(factories.A, 'u1').length, 5);
  heardFrom(factories.B, 'u2');
  assert.equal(calls.some(([seed, amount]) => seed === 'lib-1' && amount === 0.2), true);
  assert.equal(calls.some(([seed, amount]) => seed === 'lib-2' && amount === 0.8), true);
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.roomAmount, 0.2);
  assert.equal(record.persona.room.amount, 0.2);
  assert.equal(record.panel[0].roomAmount, 0.8);
  assert.equal(record.panel[0].room.amount, 0.8);
});

test('without a usable amount the room is the seed-only one and no amount is recorded', async () => {
  const setup = panelHarness({ random: () => 0.9, deps: amountRooms(), plan: drawn => soloPlan(drawn, {
    lead: { ...soloPlan(drawn).lead, room: null },
    panel: [{ voice: 'V2', role: 'Engineer', focus: '', stability: 0.5, room: Number.NaN, manner: 'Plain.' }],
  }) });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  await service.hangUp();
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.persona.room.amount, null);
  assert.equal('roomAmount' in record.persona, false);
  assert.equal('roomAmount' in record.panel[0], false);
});

// The call codec: a fake that tags every chunk and holds a tail until flush.
const codecHarness = extra => {
  const made = [];
  const pushed = [];
  const tracked = [];
  const cancelled = [];
  const warnings = [];
  const deps = {
    callCodec: ({ sampleRate, onError }) => {
      const codec = { sampleRate, onError, processed: [], flushed: 0, process(buffer) { codec.processed.push(buffer.length); return Buffer.alloc(buffer.length, 7); }, flush() { codec.flushed += 1; return Buffer.alloc(2, 9); }, reset() {} };
      made.push(codec);
      return codec;
    },
    helperFactory: () => ({
      start: async () => ({ ok: true }), play() {}, pushAudio: (id, pcm) => { pushed.push([id, Buffer.from(pcm)]); },
      endUtterance() {}, cancel: id => { cancelled.push(id); }, mute() {}, stop: async () => {},
    }),
    trackFactory: () => ({ started() {}, ended() {}, addUtterance: (id, pcm) => { tracked.push([id, Buffer.from(pcm)]); }, finalize: async () => {} }),
    logger: { warn: message => warnings.push(message), info() {}, error() {} },
    ...extra,
  };
  return { made, pushed, tracked, cancelled, warnings, deps };
};
const mirrorOf = async harness => {
  const seen = {};
  const { deps } = makeDeps({ tmp: await mkdtemp(path.join(os.tmpdir(), 'practice-call-codec-')), modelReady: true, deps: {
    ...harness.deps,
    engineFactory: options => { seen.audio = options.audio; return { start() {}, hangUp() {}, state: () => ({ transcript: [], elapsedMs: 0 }) }; },
  } });
  const service = createPracticeCallService(deps);
  await service.start(ARGS);
  await service.answer();
  return seen.audio;
};

test('the codec processes every interviewer chunk once and its tail reaches the helper and the track at the end', async () => {
  const harness = codecHarness();
  const audio = await mirrorOf(harness);
  audio.play('u1', 24000);
  audio.pushAudio('u1', Buffer.alloc(6), 24000);
  audio.pushAudio('u1', Buffer.alloc(4), 24000);
  audio.endUtterance('u1');
  assert.equal(harness.made.length, 1);
  assert.equal(harness.made[0].sampleRate, 24000);
  assert.deepEqual(harness.made[0].processed, [6, 4]);
  assert.equal(harness.made[0].flushed, 1);
  assert.deepEqual(harness.pushed.map(([, pcm]) => [...pcm].join('')), ['777777', '7777', '99']);
  assert.equal(harness.tracked.at(-1)[1].length, 12);
  assert.deepEqual([...harness.tracked.at(-1)[1].subarray(10)], [9, 9]);
});

test('a cancelled line still flushes the codec tail before it is cut off', async () => {
  const harness = codecHarness();
  const audio = await mirrorOf(harness);
  audio.play('u1', 24000);
  audio.pushAudio('u1', Buffer.alloc(6), 24000);
  audio.cancel('u1');
  assert.equal(harness.made[0].flushed, 1);
  assert.deepEqual(harness.pushed.map(([, pcm]) => pcm.length), [6, 2]);
  assert.deepEqual(harness.cancelled, ['u1']);
});

test('a throwing codec leaves the audio untouched and logs once', async () => {
  const harness = codecHarness({ callCodec: () => ({ process: () => { throw new Error('codec broke'); }, flush: () => Buffer.alloc(0), reset() {} }) });
  const audio = await mirrorOf(harness);
  const input = Buffer.from([1, 0, 2, 0]);
  audio.play('u1', 24000);
  audio.pushAudio('u1', input, 24000);
  audio.pushAudio('u1', input, 24000);
  audio.play('u2', 24000);
  audio.pushAudio('u2', input, 24000);
  assert.deepEqual(harness.pushed.map(([, pcm]) => [...pcm]), [[1, 0, 2, 0], [1, 0, 2, 0], [1, 0, 2, 0]]);
  assert.equal(harness.warnings.filter(message => message.includes('codec')).length, 1);
});

test('the warm-up line bypasses both the room and the codec', async () => {
  const harness = codecHarness();
  const setup = panelHarness({ random: () => 0.9, cast: [], deps: { ...amountRooms(), ...harness.deps } });
  const { service } = await panelStart(setup);
  await service.answer();
  const heard = heardFrom(setup.engineOptions[0].voice.panelOf.factories.A, 'warm-up');
  assert.deepEqual([...heard], [1, 0, 2, 0, 3]);
  assert.equal(harness.made.length, 0);
});

test('a solo call hands the engine a panel voice, so the share silence has a gap, with the lead alone and no panel option', async () => {
  const setup = panelHarness({ cast: [], deps: { panelVoiceFactory: createPanelVoiceFactory } });
  const { service } = await panelStart(setup);
  await service.answer();
  const options = setup.engineOptions[0];
  assert.equal('panel' in options, false, 'the engine is told of no panel');
  const stream = options.voice.open({ utteranceId: 'solo-1' });
  assert.equal(typeof stream.gap, 'function', 'the share setup can be real silence');
  assert.equal(stream.setSpeaker('B'), false, 'no other speaker exists to switch to');
  assert.equal(stream.overlay({ speakerId: 'B', text: 'yes', afterChars: 0 }), false, 'no remark can be played');
  assert.deepEqual(service.getState().participants.map(item => item.id), ['A']);
  await service.hangUp();
});

// --- the planning step: inputs, the text call, failure, the saved setup and the prepared screens ---

const flushAll = () => new Promise(resolve => setTimeout(resolve, 10));

test('plan: the planner gets the sealed brief, the pool by number, the drawn voices, the length, the focus note, the name and a signal', async () => {
  const setup = panelHarness({ cast: [] });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  setup.overrides.loadCandidateName = async () => 'Synthetic Person';
  setup.overrides.questionHistory = memoryHistory({ 'node-1': { q2: 3 } });
  setup.overrides.logger = { warn() {}, info() {} };
  setup.overrides.callText = async () => ({});
  const { state } = await panelStart(setup, { deps: setup.overrides });
  assert.equal(state.phase, 'ringing');
  assert.equal(setup.planner.calls.length, 1);
  const input = setup.planner.calls[0];
  assert.deepEqual(input.brief, { company: 'Acme', role: 'Engineer', location: '', roleSummary: '', roleThemes: [], companyFacts: [], recentContext: [] });
  assert.deepEqual(input.pool.map(item => [item.number, item.timesAsked]), [[1, 0], [2, 3], [3, 0]]);
  assert.equal(input.pool.some(item => 'answer' in item), false, 'the planner never sees prepared answers');
  assert.deepEqual(input.application, { resume: 'Synthetic resume text.', coverLetter: 'Synthetic cover letter text.' });
  assert.deepEqual(input.targetMinutes, [25, 30]);
  assert.equal(input.steering, '');
  assert.equal(input.candidateName, 'Synthetic Person');
  assert.equal(typeof input.callText, 'function');
  assert.equal(input.signal.aborted, false);
  assert.equal(input.logger, setup.overrides.logger);
  assert.deepEqual(input.voices.map(voice => voice.key), ['V1', 'V2', 'V3']);
});

test('plan: the focus note reaches the planner, and the planner is asked once before any session exists', async () => {
  const order = [];
  const setup = panelHarness({ cast: [] });
  const inner = setup.overrides.planCall;
  setup.overrides.planCall = async input => { order.push('plan'); return inner(input); };
  setup.overrides.sessionsFactory = () => { order.push('session'); return { start: async () => ({ reply: 'READY' }) }; };
  const { state } = await panelStart(setup, { deps: setup.overrides });
  assert.equal(state.phase, 'ringing');
  assert.deepEqual(order, ['plan', 'session', 'session', 'session']);
  const built = makeDeps({ tmp: await mkdtemp(path.join(os.tmpdir(), 'practice-call-plan-steer-')), modelReady: true, deps: { planCall: fakePlanner() } });
  await createPracticeCallService(built.deps).start({ ...ARGS, steering: '  Ask about pay.  ' });
  assert.equal(built.deps.planCall.calls[0].steering, 'Ask about pay.');
});

test('plan: without planText the planner calls the service text call with the planning task and stage; planText wins when given', async () => {
  const seen = [];
  const viaCallText = fakePlanner();
  const planner = async input => {
    await input.callText({ prompt: 'P', schema: { type: 'object' }, signal: 'S' });
    return viaCallText(input);
  };
  const callText = async request => { seen.push(['callText', request]); return {}; };
  const first = await startOf({ deps: { planCall: planner, callText } });
  await first.service.start(ARGS);
  assert.deepEqual(seen, [['callText', { prompt: 'P', schema: { type: 'object' }, signal: 'S', task: 'practice-plan', claudeStage: 'practice-call-plan' }]]);

  seen.length = 0;
  const planText = async request => { seen.push(['planText', request]); return {}; };
  const second = await startOf({ deps: { planCall: planner, callText, planText } });
  await second.service.start(ARGS);
  assert.deepEqual(seen, [['planText', { prompt: 'P', schema: { type: 'object' }, signal: 'S' }]]);
});

test('plan: a failed plan ends in an error state, starts no session, warms nothing and cleans the call folder up', async () => {
  const created = { sessions: 0, helpers: 0, tracks: 0 };
  const warnings = [];
  const harness = voiceHarness({ audio: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'practice-call-plan-fail-'));
  const planCall = async () => { throw Object.assign(new Error('could not plan after 3 attempts'), { code: 'plan-failed', attempts: [{ problems: ['a question number is not in the pool'] }, { problems: ['the minutes are too long'] }] }); };
  const { deps } = makeDeps({ tmp, modelReady: true, deps: {
    planCall, voiceFactory: harness.make,
    sessionsFactory: () => { created.sessions += 1; throw new Error('no sessions without a plan'); },
    helperFactory: () => { created.helpers += 1; throw new Error('no helper without a plan'); },
    trackFactory: () => { created.tracks += 1; throw new Error('no track without a plan'); },
    logger: { warn: message => warnings.push(message), info: message => warnings.push(message) },
  } });
  const service = createPracticeCallService(deps);
  const states = [];
  service.onState(item => states.push(item));
  const state = await service.start(ARGS);
  assert.equal(state.phase, 'error');
  assert.equal(state.error.code, 'plan-failed');
  assert.equal(state.error.message, 'The interview could not be planned. Try starting the call again.');
  assert.equal(state.notice, null, 'the planning notice is cleared');
  assert.deepEqual(created, { sessions: 0, helpers: 0, tracks: 0 });
  assert.equal(harness.factories.length, 0, 'no voice is made or warmed');
  assert.equal(states.some(item => item.phase === 'ringing'), false, 'nothing rings');
  assert.equal(warnings.some(line => line.includes('plan-failed') && line.includes('could not plan after 3 attempts')), true, 'the cause is logged');
  assert.equal(warnings.some(line => line.includes('a question number is not in the pool')), true, 'so are the problems of each attempt');
  assert.equal(await readFile(poolFilePath(tmp), 'utf8').then(() => true, () => false), false, 'no lastUsed stamp is saved');
  await flushAll();
  assert.equal(await deps.store.readRecord('call-1'), null, 'no record is left behind');
  assert.equal((await nodeFs.readdir(path.join(tmp, 'practice-calls'))).includes('call-1'), false, 'the call folder is gone');
  // The service is free for a new start afterwards (it fails again here only because the planner still does).
  assert.equal((await service.start(ARGS)).error.code, 'plan-failed');
});

test('plan: a plan that names a voice that was not drawn, or a planner that returns nothing, fails the call the same way', async () => {
  for (const [label, planCall] of [
    ['unknown lead', async ({ voices }) => ({ plan: soloPlan(voices, { lead: { ...soloPlan(voices).lead, voice: 'V9' } }), attempts: [], ms: 1 })],
    ['unknown colleague', async ({ voices }) => ({ plan: soloPlan(voices, { panel: [{ voice: 'V9', role: 'Engineer', focus: '', stability: 0.3, room: 0.4, manner: '' }] }), attempts: [], ms: 1 }), ],
    ['nothing', async () => ({})],
  ]) {
    let sessions = 0;
    const { service } = await startOf({ deps: { planCall, sessionsFactory: () => { sessions += 1; return { start: async () => {} }; } } });
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'error', label);
    assert.equal(state.error.code, 'plan-failed', label);
    assert.equal(sessions, 0, label);
  }
});

test('plan: the setup phase shows a planning notice that is gone once the call rings', async () => {
  const notices = [];
  let service;
  const planCall = async input => {
    notices.push(service.getState().notice);
    return { plan: soloPlan(input.voices), attempts: [], ms: 1 };
  };
  const built = await startOf({ deps: { planCall } });
  service = built.service;
  const phases = [];
  service.onState(item => phases.push([item.phase, item.notice?.message ?? null]));
  const state = await service.start(ARGS);
  assert.deepEqual(notices, [{ code: 'planning', message: 'Planning the interview' }]);
  assert.equal(phases.some(([phase, message]) => phase === 'precheck' && message === 'Planning the interview'), true);
  assert.equal(state.phase, 'ringing');
  assert.equal(state.notice, null);
});

test('plan: hanging up while the plan is being made aborts it and neither fails nor starts anything', async () => {
  let signal;
  let sessions = 0;
  let release;
  const planCall = input => new Promise((resolve, reject) => {
    signal = input.signal;
    release = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    input.signal.addEventListener('abort', release);
  });
  const { service } = await startOf({ deps: { planCall, sessionsFactory: () => { sessions += 1; return { start: async () => {} }; } } });
  const starting = service.start(ARGS);
  await flushAll();
  assert.equal(service.getState().notice.message, 'Planning the interview');
  const ended = await service.hangUp();
  assert.equal(signal.aborted, true, 'the planning call is told to stop');
  assert.equal(ended.error, null, 'a hang-up during planning is not an error');
  const final = await starting;
  assert.notEqual(final.error?.code, 'plan-failed');
  assert.equal(sessions, 0);
});

test('plan: the setup is saved with the record and logged as it happens', async () => {
  const lines = [];
  const attempts = [{ problems: ['a probe is too long'] }, { problems: ['the minutes are too long'] }];
  const planCall = async ({ voices }) => ({
    plan: soloPlan(voices, {
      panel: [{ voice: 'V2', role: 'Engineer', focus: 'api', stability: 0.3, room: 0.4, manner: 'Plain.' }],
      problems: [{ ref: 'p1', question: 1, language: 'javascript', parts: [{ title: 'Task', content: 'Sum a list.' }], solution: 'return 1;', edgeCases: [], hints: [] }],
    }),
    attempts, ms: 4321,
  });
  const setup = panelHarness({ random: () => 0.9, deps: { planCall, logger: { warn: line => lines.push(['warn', line]), info: line => lines.push(['info', line]) } } });
  const { service, deps } = await panelStart(setup);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.equal(record.setup.plan.interviewKind, 'A short screening conversation.');
  assert.deepEqual(record.setup.planAttempts, [['a probe is too long'], ['the minutes are too long']]);
  assert.equal(record.setup.planMs, 4321);
  assert.deepEqual(record.setup.voices.map(voice => [voice.key, voice.name, voice.voiceId, voice.used, voice.id]), [
    ['V1', 'Nora Lead', 'lib-1', true, 'A'], ['V2', 'Ben Specialist', 'lib-2', true, 'B'], ['V3', 'Cara Second', 'lib-3', false, null],
  ]);
  assert.equal(JSON.stringify(record.setup).includes('key-should-never-be-logged'), false);
  const info = lines.filter(([level]) => level === 'info').map(([, line]) => line);
  assert.equal(info.some(line => line.includes('voices drawn') && line.includes('Nora Lead') && line.includes('V3')), true, 'the drawn voices are logged');
  const planned = info.find(line => line.includes('plan {'));
  assert.ok(planned, 'the plan summary is logged');
  assert.equal(planned.includes('"ms":4321') && planned.includes('"attempts":2') && planned.includes('"problems":["p1"]'), true);
});

test('plan: the log falls back to warn when the logger has no info', async () => {
  const lines = [];
  const setup = panelHarness({ cast: [], deps: { logger: { warn: line => lines.push(line) } } });
  await panelStart(setup);
  assert.equal(lines.some(line => line.includes('voices drawn')) && lines.some(line => line.includes('plan {')), true);
});

test('plan: the engine gets the prepared problems by reference, and none when the plan has none', async () => {
  const withProblems = panelHarness({ cast: [], plan: drawn => soloPlan(drawn, {
    problems: [
      { ref: 'p1', question: 1, language: 'python', parts: [{ title: 'Task', content: 'Add two numbers.' }, { title: 'Example', content: 'add(1, 2) returns 3.' }], solution: 'return a + b', edgeCases: ['negative'], hints: ['look at the signature'] },
    ],
  }) });
  const first = await panelStart(withProblems);
  await first.service.answer();
  assert.deepEqual(withProblems.engineOptions[0].prepared, { p1: { parts: [{ title: 'Task', content: 'Add two numbers.' }, { title: 'Example', content: 'add(1, 2) returns 3.' }] } }, 'only what the screen shows, never the solution');
  const main = withProblems.built.find(item => item.kind === 'main');
  assert.equal(main.options.callPlan.problems[0].solution, 'return a + b', 'the solution goes to the interviewer prompt only');

  const without = panelHarness({ cast: [] });
  const second = await panelStart(without);
  await second.service.answer();
  assert.deepEqual(without.engineOptions[0].prepared, {});
});

test('plan: the interviewer sessions reply a bare READY, and anything they return is not read as a setup', async () => {
  const replies = ['READY', 'READY tough {"role":"Somebody Else","questions":[3]}', undefined];
  for (const reply of replies) {
    const harness = recordingPrompts();
    const { service, deps } = await startOf({ deps: { prompts: harness.prompts, loadCards: async () => PLAN_CARDS, sessionsFactory: () => ({ start: async () => (reply === undefined ? undefined : { reply }), close() {} }) } });
    const state = await service.start(ARGS);
    assert.equal(state.phase, 'ringing');
    assert.equal(state.persona.role, 'Hiring Manager', 'the plan, not a reply, decides the role');
    assert.equal(harness.built.length, 2, 'no second build after a reply');
    await service.answer();
    await service.hangUp({ feedback: false });
    assert.deepEqual((await deps.store.readRecord('call-1')).pickedQuestions, [1]);
  }
});

// --- the unprepared question, the application and the prepared answers ---

const UNPREPARED_TEXT = 'Tell me about a time a plan changed under you, and what you did next.';
const unpreparedPlan = drawn => soloPlan(drawn, {
  panel: [{ voice: 'V2', role: 'Senior Engineer', focus: 'system design', stability: 0.3, room: 0.4, manner: 'Plain.' }],
  questions: [
    { number: 1, askedBy: 'V1', minutes: 8, probes: [] },
    { number: 0, text: UNPREPARED_TEXT, askedBy: 'V2', minutes: 5, probes: ['the part of the resume that matches'] },
    { number: 2, askedBy: 'V1', minutes: 6, probes: [] },
  ],
});

test('unprepared question: number 0 keeps its text, never counts as asked or picked, and is saved for the review', async () => {
  const setup = panelHarness({ plan: unpreparedPlan });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const history = memoryHistory();
  setup.overrides.questionHistory = history;
  const inner = setup.overrides.engineFactory;
  setup.overrides.engineFactory = options => {
    const engine = inner(options);
    return { ...engine, state: () => ({ transcript: [{ speaker: 'candidate', text: 'hello' }], elapsedMs: 5000, askedQuestions: [1, 0, 2] }) };
  };
  const { service, deps } = await panelStart(setup);
  const main = setup.built.find(item => item.kind === 'main');
  assert.deepEqual(main.options.picked, [1, 2], 'only pool numbers are picked');
  assert.deepEqual(main.options.callPlan.questions.map(item => [item.number, item.askedBy, item.text]), [[1, 'A', undefined], [0, 'B', UNPREPARED_TEXT], [2, 'A', undefined]]);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.deepEqual(record.askedQuestions, [1, 2]);
  assert.deepEqual(history.recorded.map(item => item.ids), [['q1', 'q2']], 'the unprepared question never enters the rotation history');
  assert.deepEqual(record.unpreparedQuestion, { text: UNPREPARED_TEXT, askedBy: 'B' });
  assert.equal(record.setup.plan.questions.find(item => item.number === 0).text, UNPREPARED_TEXT);
});

test('unprepared question: a colleague who drops out hands their unprepared question to the lead', async () => {
  const setup = panelHarness({ plan: unpreparedPlan, random: () => 0.9, silent: ['lib-2'] });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const { deps, service } = await panelStart(setup);
  const mains = setup.built.filter(item => item.kind === 'main');
  assert.deepEqual(mains.at(-1).options.callPlan.questions.map(item => [item.number, item.askedBy]), [[1, 'A'], [0, 'A'], [2, 'A']]);
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.deepEqual((await deps.store.readRecord('call-1')).unpreparedQuestion, { text: UNPREPARED_TEXT, askedBy: 'A' });
});

test('application: both prompt builders and the planner get it, and none of them gets a prepared answer', async () => {
  const setup = panelHarness({});
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const seen = [];
  setup.overrides.loadApplication = async args => { seen.push(args); return { resume: 'Synthetic resume text.', coverLetter: '' }; };
  const { deps, service } = await panelStart(setup);
  assert.equal(seen[0].artifactId, ARGS.bundleArtifactId);
  assert.equal(seen[0].userDataPath, deps.userDataPath);
  assert.deepEqual(setup.planner.calls[0].application, { resume: 'Synthetic resume text.', coverLetter: '' });
  for (const item of setup.built) {
    assert.deepEqual(item.options.application, { resume: 'Synthetic resume text.', coverLetter: '' }, `${item.kind} gets the application`);
    assert.equal(item.options.plan.some(card => 'answer' in card), false, `${item.kind} gets the pool without answers`);
    assert.deepEqual(item.options.plan.map(card => card.number), [1, 2, 3]);
  }
  assert.equal(JSON.stringify([setup.planner.calls[0].pool, setup.built.map(item => item.options.plan)]).includes('I led one.'), false);
  await service.answer();
  await service.hangUp({ feedback: false });
  const record = await deps.store.readRecord('call-1');
  assert.equal(JSON.stringify(record).includes('Synthetic resume text.'), false, 'the application text is not saved in the call record');
});

test('application: a failing or empty load reads as two empty strings and never stops the call, with no contents logged', async () => {
  for (const [label, load] of [['throws', async () => { throw new Error('private body: Synthetic resume text.'); }], ['null', async () => null]]) {
    const setup = panelHarness({});
    setup.overrides.loadCards = async () => PLAN_CARDS;
    const warnings = [];
    setup.overrides.logger = { warn: message => warnings.push(String(message)), info() {} };
    setup.overrides.loadApplication = load;
    const { state } = await panelStart(setup);
    assert.equal(state.phase, 'ringing', label);
    assert.deepEqual(setup.planner.calls[0].application, { resume: '', coverLetter: '' }, label);
    assert.equal(warnings.some(line => line.includes('application text unavailable')), true, label);
    assert.equal(warnings.some(line => line.includes('Synthetic resume text.')), false, `${label}: contents are never logged`);
  }
});

test('real prompt: a planner-shaped plan with colleagues reaches the real interviewer prompt by name', async () => {
  const prompts = await import('../../electron/interviewPracticeCallPrompt.js');
  const setup = panelHarness({ plan: unpreparedPlan, random: () => 0.9 });
  setup.overrides.loadCards = async () => PLAN_CARDS;
  await panelStart(setup);
  const main = setup.built.find(item => item.kind === 'main');
  const text = prompts.buildInterviewerInstructions(main.options);
  assert.equal(typeof text, 'string');
  assert.equal(text.includes('Ben Specialist'), true, 'the colleague is named in the prompt');
  assert.equal(text.includes('Nora Lead'), true, 'the lead is named in the prompt');
  assert.equal(text.includes(UNPREPARED_TEXT), true, 'the unprepared question text reaches the prompt');
  assert.equal(text.includes('I led one.'), false, 'no prepared answer reaches the prompt');
});

test('application: with no resume and no cover letter the career documents fill the resume slot, flagged, and are not saved', async () => {
  const setup = panelHarness({});
  setup.overrides.loadCards = async () => PLAN_CARDS;
  const seen = [];
  setup.overrides.loadApplication = async () => ({ resume: '', coverLetter: ' ' });
  setup.overrides.loadCareerDocuments = async args => { seen.push(args); return '===== FILE: a.pdf.txt =====\nSynthetic career text.'; };
  const { deps, service } = await panelStart(setup);
  assert.equal(seen[0].snapshotId, ARGS.snapshotId);
  assert.equal(seen[0].userDataPath, deps.userDataPath);
  const expected = { resume: '===== FILE: a.pdf.txt =====\nSynthetic career text.', coverLetter: '', source: 'career-documents' };
  assert.deepEqual(setup.planner.calls[0].application, expected);
  for (const item of setup.built) assert.deepEqual(item.options.application, expected);
  await service.answer();
  await service.hangUp({ feedback: false });
  assert.equal(JSON.stringify(await deps.store.readRecord('call-1')).includes('Synthetic career text.'), false);
});

test('application: career documents are not read when an application exists, and a failing read never stops the call', async () => {
  const unused = panelHarness({});
  unused.overrides.loadCards = async () => PLAN_CARDS;
  let reads = 0;
  unused.overrides.loadApplication = async () => ({ resume: 'Synthetic resume text.', coverLetter: '' });
  unused.overrides.loadCareerDocuments = async () => { reads += 1; return 'x'; };
  await panelStart(unused);
  assert.equal(reads, 0);
  for (const load of [async () => { throw new Error('private body: Synthetic career text.'); }, async () => '  ']) {
    const setup = panelHarness({});
    setup.overrides.loadCards = async () => PLAN_CARDS;
    const warnings = [];
    setup.overrides.logger = { warn: message => warnings.push(String(message)), info() {} };
    setup.overrides.loadApplication = async () => ({ resume: '', coverLetter: '' });
    setup.overrides.loadCareerDocuments = load;
    const { state } = await panelStart(setup);
    assert.equal(state.phase, 'ringing');
    assert.deepEqual(setup.planner.calls[0].application, { resume: '', coverLetter: '' });
    assert.equal(warnings.some(line => line.includes('Synthetic career text.')), false);
  }
});

const CAREER_SNAPSHOT = { sources: [{ name: 'a.pdf.txt', text: 'Alpha text.' }, { name: 'b.txt', text: 'Beta text.' }] };

test('career document text: reads the pinned snapshot read-only and returns every file', async () => {
  const calls = [];
  const text = await loadCareerDocumentText({
    snapshotId: 's1', userDataPath: '/data',
    storageRoot: root => `${root}/store`, readSnapshot: async (...args) => { calls.push(args); return CAREER_SNAPSHOT; },
    toText: value => value.sources.map(s => `===== FILE: ${s.name} =====\n${s.text}`).join('\n\n'),
  });
  assert.equal(text, '===== FILE: a.pdf.txt =====\nAlpha text.\n\n===== FILE: b.txt =====\nBeta text.');
  assert.deepEqual(calls, [['/data/store', 's1', { readOnly: true }]]);
});

test('career document text: missing arguments or snapshot read as empty', async () => {
  assert.equal(await loadCareerDocumentText({}), '');
  assert.equal(await loadCareerDocumentText({ snapshotId: 's', userDataPath: '/d', storageRoot: r => r, readSnapshot: async () => null }), '');
});

test('career document text: the cap keeps every file represented and a short file leaves room to the others', () => {
  const long = 'x'.repeat(500);
  const input = `===== FILE: a =====\n${long}\n\n===== FILE: b =====\nshort\n\n===== FILE: c =====\n${long}`;
  const out = capCareerDocumentText(input, 200);
  assert(out.length <= 200 + 4);
  for (const name of ['a', 'b', 'c']) assert(out.includes(`===== FILE: ${name} =====`) || out.includes(`FILE: ${name}`), name);
  assert(out.includes('short'));
  assert.equal(capCareerDocumentText('abc', 200), 'abc');
  assert.equal(capCareerDocumentText('y'.repeat(300), 100).length, 100);
});
