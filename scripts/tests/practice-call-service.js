import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCallStore } from '../../electron/practiceCall/callStore.js';
import { createVoicePoolStore, drawVoice } from '../../electron/practiceCall/eleven/voiceLibrary.js';
import { createPracticeCallService } from '../../electron/practiceCall/callService.js';
import { createReplayHandler } from '../../electron/practiceCall/replayProtocol.js';

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
    orderCards: cards => cards,
    registryStatus: async () => ({ order: [] }),
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
    trackFactory: () => ({ started() {}, ended() {}, addUtterance() {}, finalize: async () => { events.push('finalize'); } }),
    earFactory: () => ({ noteSpeech() {}, voiceNote: () => null, endOfTurn: async () => 0.5, floorBid: async () => ({ decision: 'pause' }), toneSamples: () => [] }),
    sessionsFactory: () => ({ start: async () => {} }),
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
  assert.equal(['ended', 'analyzing', 'replay'].includes(endedService.getState().phase), true);
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

test('without a requested temperament the interviewer chooses one that fits its voice', async () => {
  const sessionsOf = replies => {
    const starts = [];
    let made = 0;
    const factory = () => {
      const kind = ['opener', 'main', 'classifier'][made++];
      return { start: async ({ instructions }) => { starts.push({ kind, instructions }); return replies[kind]; } };
    };
    return { starts, factory };
  };
  const character = { traits: 'Dominant, Firm', descriptive: '', about: 'Brash and openly confident.' };
  const run = async ({ reply, loadBrief } = {}) => {
    const seen = {};
    const { starts, factory } = sessionsOf({ main: reply, opener: { reply: 'READY' }, classifier: { reply: 'READY' } });
    const built = await startOf({ modelReady: true, deps: {
      random: () => 0,
      sessionsFactory: factory,
      prompts: {
        buildInterviewerInstructions: ({ persona }) => `main:${persona.temperament ?? 'choose'}:${persona.voice?.character?.traits}`,
        buildOpenerInstructions: ({ persona }) => `opener:${persona.temperament ?? 'choose'}`,
        temperamentFromReady: text => (/^READY (warm|neutral|tough)$/.exec(text ?? '') ?? [])[1] ?? null,
      },
      catalog: {
        listConversationalVoices: async () => [{ voiceId: 'v1', name: 'Ada Lovelace' }],
        pickPersonaVoice: options => {
          seen.temperament = options.temperament;
          return { voiceId: 'v1', name: 'Ada Lovelace', gender: 'male', age: 'middle_aged', accent: 'american', character, temperament: null };
        },
      },
    } });
    if (loadBrief) built.deps.loadBrief = loadBrief(built.deps.loadBrief);
    const service = createPracticeCallService(built.deps);
    const state = await service.start(ARGS);
    return { seen, starts, state, built };
  };
  const chosen = await run({ reply: { reply: 'READY tough' } });
  assert.equal(chosen.seen.temperament, null);
  const main = chosen.starts.find(item => item.kind === 'main');
  const opener = chosen.starts.find(item => item.kind === 'opener');
  assert.equal(main.instructions, 'main:choose:Dominant, Firm');
  assert.equal(opener.instructions, 'opener:tough');
  // The main session chose before the opener started, so their temperaments match.
  assert.ok(chosen.starts.indexOf(main) < chosen.starts.indexOf(opener));
  assert.equal(chosen.state.persona.role, 'Hiring Manager');
  assert.equal(chosen.state.persona.team, 'the hiring team');

  const unclear = await run({ reply: { reply: 'READY' } });
  assert.equal(unclear.starts.find(item => item.kind === 'opener').instructions, 'opener:neutral');

  const asked = await run({
    reply: { reply: 'READY' },
    loadBrief: brief => async args => {
      const loaded = await brief(args);
      return { ...loaded, role: { ...loaded.role, team: 'Platform' }, practice: { temperament: 'tough' } };
    },
  });
  assert.equal(asked.seen.temperament, 'tough');
  assert.equal(asked.starts.find(item => item.kind === 'main').instructions, 'main:tough:Dominant, Firm');
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
      finish: (code, feedback) => { log.push(`finish:${code}:${feedback.callId}`); return { ok: true }; },
    };
    const { service } = await startOf({ deps: {
      registry,
      analyze: async () => ({ status: 'ready', chapters: [], feedback: { summary: 'solid', callId: null } }),
    } });
    await service.start(ARGS);
    await service.answer();
    const state = await service.hangUp();
    assert.equal(state.phase, 'replay');
    assert.equal(log.includes('arm:node-1:Acme:Engineer:1'), true);
    assert.equal(log.includes('finish:session-1:call-1'), true);
    assert.equal(log.indexOf('arm:node-1:Acme:Engineer:1') < log.indexOf('finish:session-1:call-1'), true);
    assert.equal(log.includes('cancel:node-1'), alreadyArmed);
    assert.equal(log.filter(item => item.startsWith('arm:')).length, alreadyArmed ? 2 : 1);
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
  await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-1' });
  assert.equal(windows.length, 1, 'a replay view reuses the open window');
  windows[0].close();
  assert.equal(abandons.length, 0, 'closing a reused window uses its current replay mode');
  await invoke('practice-call:open-replay', { nodeId: 'n1', callId: 'call-1' });
  assert.equal(windows.length, 2);
  await invoke('practice-call:start', { nodeId: 'n1' });
  assert.equal(windows[1].destroyed, true, 'the replay window is closed first');
  assert.equal(windows.length, 3);
  assert.equal(windows[2].search, 'view=practice-call&callId=call-1');
  windows[2].close();
  assert.equal(abandons.length, 1, 'closing a live call window abandons the call');
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
  assert.equal(record.toneNotes.length, 1);
  assert.equal(record.toneNotes[0].atMs, 1);
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
  voice_id: 'lib-1', public_owner_id: 'owner-1', name: 'Nora', category: 'professional',
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
  assert.equal(draws.length, 1);
  assert.equal('accountVoices' in draws[0], false, 'the draw is never handed the account voices');
  assert.deepEqual(draws[0].excludeVoiceIds, ['lib-2'], 'the newest pool stamp is the avoided voice');
  assert.equal(draws[0].random, random);
  assert.equal(draws[0].key, 'key-should-never-be-logged');
  assert.equal(draws[0].fetch, deps.fetch);
  assert.deepEqual(catalog.listings, [], 'the account voice list is never read');
  assert.deepEqual(catalog.picks.map(pick => pick.voices.map(voice => voice.voiceId)), [['lib-1']]);
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
  assert.equal(harness.factories.length, 1, 'one factory, for the library voice');
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
  assert.deepEqual(catalog.picks.map(pick => pick.voices.map(voice => voice.voiceId)), [['lib-1']]);
  assert.deepEqual(catalog.listings, []);
  assert.deepEqual(unhandled, []);
});

