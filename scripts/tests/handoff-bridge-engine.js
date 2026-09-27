import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { createHandoffEngine } from '../../electron/ipc/handoffBridge/engine.js';
import { createHandoffBridgePower } from '../../electron/ipc/handoffBridge/power.js';
import { createLaneStore } from '../../electron/ipc/handoffBridge/laneStore.js';
import { createAuditSink, makeAuditLine, SECURITY_AUDIT_EVENTS } from '../../electron/ipc/handoffBridge/audit.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';
import { APPLICATION_FENCE_RE, DUPLICATE_RESPONSE_MIN_CHARS, MAX_RESPONSE_BYTES, classifySubmission, extractPasteEnvelopeIdentity, normalizePastedResponse, responseFingerprint, stringifySubmission, trimHandoffCode } from '../../electron/ipc/handoffBridge/preflight.js';
import { APPLICATION_INSTRUCTIONS, REJECTED_CAUTION, RESULT_NOTES, clipCorrectionItem, frameCorrections, makeRejectedBody, makeServedBody } from '../../electron/ipc/handoffBridge/framing.js';
import { createApplicationLane, createHandoffCodeGuard, holdLane, isHumanAdvance, makeChatKey, rehydrateApplicationLane, remainingCounts, resumeLane, tombstoneCode } from '../../electron/ipc/handoffBridge/lanes.js';
import { AUDIT_LINE_EXAMPLE, ENGINE_PORT_SHAPE, SOURCE_ADAPTER_SHAPE, STATUS_SNAPSHOT_EXAMPLE, TUNNEL_PORT_SHAPE } from '../../electron/ipc/handoffBridge/contracts.js';
import { classifyThrow, fixedError } from '../../electron/ipc/handoffBridge/errors.js';
import { createHandoffBridgeLog, makeLogRecord } from '../../electron/ipc/handoffBridge/log.js';

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';
const PATH_A = '/tmp/marisol.canvas';
const PATH_B = '/tmp/ada.canvas';
const LINK = 'link-synthetic';
const codeGuard = createHandoffCodeGuard();

function handoff({ code = 'HANDOFF-A', jobId = JOB_A, stage = 'resume', revision = 1, prompt = 'Synthetic application prompt.' } = {}) {
  return { code, jobId, stage, revision, prompt };
}

function answer({ jobId = JOB_A, code = 'HANDOFF-A', stage = 'resume', extra = {} } = {}) {
  return JSON.stringify({ jobId, stage, handoffCode: code, text: 'Synthetic answer '.repeat(8), ...extra });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function source(overrides = {}) {
  const calls = { read: 0, status: 0, submit: 0 };
  const api = {
    read: async ({ jobId }) => { calls.read++; return { kind: 'open', handoff: handoff({ code: jobId === JOB_B ? 'HANDOFF-B' : 'HANDOFF-A', jobId }) }; },
    status: async () => { calls.status++; return { kind: 'host' }; },
    submit: async () => { calls.submit++; return { kind: 'accepted', completed: true }; },
    ...overrides,
  };
  return { calls, api };
}

async function started({ sourceOverrides, clock = createFakeClock(), engineOptions = {} } = {}) {
  const fake = source(sourceOverrides);
  const engine = createHandoffEngine({ source: fake.api, now: clock.now, timers: clock, random: () => Buffer.alloc(26, 7), holdMs: 0, ...engineOptions });
  assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'synthetic lane must release');
  const chat = await engine.newChat({ linkId: LINK });
  assert(chat.copied, 'synthetic chat must start');
  return { engine, fake, clock, session: chat.sessionCode };
}

async function served(options = {}) {
  const state = await started(options);
  const result = await state.engine.get({ session: state.session, linkId: LINK });
  assert(result.status === 'served', `expected served handoff, got ${result.status}`);
  return { ...state, result };
}

function cleanDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ic-handoff-engine-')); }

const tests = [
  {
    name: 'handoff bridge: engine: frozen port and status contracts are complete and immutable',
    run: () => {
      assert(ENGINE_PORT_SHAPE.join(',') === 'get,submit,snapshot,close', 'engine port shape drifted');
      assert(SOURCE_ADAPTER_SHAPE.join(',') === 'read,status,submit', 'source adapter shape drifted');
      assert(TUNNEL_PORT_SHAPE.join(',') === 'start,stop,status,reapOrphans', 'tunnel port shape drifted');
      assert(STATUS_SNAPSHOT_EXAMPLE.v === 1 && STATUS_SNAPSHOT_EXAMPLE.power.keepAwake === false, 'status example must be safe and versioned');
      assert(STATUS_SNAPSHOT_EXAMPLE.limits.idlePauseMinutes === 1440, 'status example must expose the accepted idle default');
      assert(Object.isFrozen(STATUS_SNAPSHOT_EXAMPLE.queue.applications), 'status contract must be deeply immutable');
      assert(!JSON.stringify(STATUS_SNAPSHOT_EXAMPLE).match(/prompt|handoffCode|canvasFilePath|label/i), 'status contract must not expose content or identifiers');
      assert(Object.keys(AUDIT_LINE_EXAMPLE).join(',') === 't,ev,tool,outcome,stage,argBytes,resultBytes,ms,grantFp,epochFp,source,tokenLeftSec', 'serve audit schema drifted');
    },
  },
  {
    name: 'handoff bridge: engine: errors logs and audit lines reject free text',
    run: () => {
      assert(fixedError('no_hostname').message === 'A bridge hostname is required.', 'fixed error sentence drifted');
      assert(classifyThrow({ code: 'no_hostname', message: 'secret prompt' }).code === 'no_hostname', 'classification must use only code');
      assert(classifyThrow({ code: 'not-a-code', message: 'secret prompt' }).code === 'internal_error', 'unknown codes must collapse');
      assert(makeLogRecord('pause', { cause: 'idle' }).fields.cause === 'idle', 'safe enumerated log fields must pass');
      for (const attempt of [
        () => makeLogRecord('unknown', {}), () => makeLogRecord('pause', { reason: 'free text with spaces' }),
        () => makeLogRecord('link_created', { candidate: 'ada' }), () => makeLogRecord('pause', { tool: 'get_handoff' }),
        () => makeAuditLine({ event: 'served', fields: { prompt: 'secret' } }), () => makeAuditLine({ event: 'served', fields: { code: 'safe-looking-code' } }),
        () => makeAuditLine({ event: 'not_enumerated', fields: {} }),
      ]) { let threw = false; try { attempt(); } catch { threw = true; } assert(threw, 'free-form log or audit input must be rejected'); }
      assert(makeAuditLine({ at: 1, event: 'served', fields: { tool: 'get_handoff', outcome: 'ok', argBytes: 12 } }).ev === 'served', 'enumerated serve audit must pass');
    },
  },
  {
    name: 'handoff bridge: engine: concrete bridge logger validates exact output and bounds redacted Activity',
    run: async () => {
      let stamp = 100; const lines = [];
      const log = createHandoffBridgeLog({ logger: { info: line => lines.push(line) }, now: () => ++stamp });
      log.record('tool_call', { ms: 7, outcome: 'served', tool: 'get' });
      assert(lines[0] === '[HandoffBridge] tool_call tool=get outcome=served ms=7', 'app logger output must use the exact closed record format and field order');
      assert(JSON.stringify(log.getRecent()) === JSON.stringify([{ kind: 'get-served', at: 101, outcome: 'served' }]) && log.getVersion() === 1,
        'a safe credential record becomes one redacted Activity item and increments its monotonic version');
      let threw = false;
      try { log.record('tool_call', { tool: 'get', outcome: 'secret prompt with spaces', ms: 8 }); } catch { threw = true; }
      assert(threw && lines.length === 1 && log.getRecent().length === 1 && log.getVersion() === 1,
        'unsafe fields must be rejected before either the app logger or Activity ring changes');
      for (let index = 0; index < 205; index += 1) log.record('pause', { cause: 'user' });
      const activity = log.getRecent();
      assert(activity.length === 200 && log.getVersion() === 206 && activity.every(item => item.kind === 'paused' && item.outcome === 'paused'),
        'Activity retains only its newest 200 safe projections while its version never wraps with the ring');

      let failPersistence = false; const persistLines = [];
      const engine = createHandoffEngine({
        source: source().api,
        store: { saveLanes: async () => !failPersistence },
        logger: createHandoffBridgeLog({ logger: { info: line => persistLines.push(line) }, now: () => stamp }),
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'fixture lane must persist before its injected failure');
      failPersistence = true;
      assert((await engine.hold(JOB_A)).code === 'persist_failed', 'a failed lane write must fail closed');
      assert(persistLines.includes('[HandoffBridge] persist_failed code=persist_failed store=lanes'),
        'engine persistence failures use only the frozen persist_failed field schema');
    },
  },
  {
    name: 'handoff bridge: engine: lifecycle audit events remain allow-listed and redacted',
    run: async () => {
      const emitted = [];
      const engine = createHandoffEngine({
        source: source().api,
        audit: { append: (event, fields) => { emitted.push({ event, fields }); return Promise.resolve(true); } },
      });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'release must succeed');
      assert((await engine.pause('manual')).ok && (await engine.resume({})).ok, 'bridge pause and resume must succeed');
      assert((await engine.unrelease(JOB_A)).ok, 'unrelease must succeed');
      for (const event of ['pause', 'resume', 'release', 'unrelease']) {
        assert(SECURITY_AUDIT_EVENTS.includes(event), `${event} must be a security audit event`);
        const record = emitted.find(item => item.event === event);
        assert(record && makeAuditLine({ at: 1, event, fields: record.fields }).ev === event, `${event} must pass the audit boundary`);
      }
      let threw = false;
      try { makeAuditLine({ event: 'release', fields: { jobId: JOB_A } }); } catch { threw = true; }
      assert(threw, 'audit lines must reject raw job identifiers');
    },
  },
  {
    name: 'handoff bridge: engine: preflight rejects all empty and non-object envelopes',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      for (const value of ['', '   ', '{}', '[]', 'null', '"text"', 'x'.repeat(63)]) assert(classifySubmission({ response: value, lane }) === 'junk', `must be junk: ${value.slice(0, 8)}`);
    },
  },
  {
    name: 'handoff bridge: engine: preflight rejects every missing application envelope key',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      for (const missing of ['jobId', 'stage', 'handoffCode']) {
        const value = { jobId: JOB_A, stage: 'resume', handoffCode: 'HANDOFF-A' }; delete value[missing];
        assert(classifySubmission({ response: JSON.stringify(value), lane }) === 'junk', `${missing} is required`);
      }
    },
  },
  {
    name: 'handoff bridge: engine: preflight identifies parsed and regex-extracted foreign jobs',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      assert(classifySubmission({ response: JSON.stringify({ jobId: JOB_B, stage: 'resume', handoffCode: 'HANDOFF-A' }), lane }) === 'misrouted', 'foreign parsed job must misroute');
      assert(classifySubmission({ response: `{"jobId":"${JOB_B}", ${'broken '.repeat(12)}`, lane }) === 'misrouted', 'foreign regex job must misroute');
      assert(extractPasteEnvelopeIdentity(`{"jobId":"${JOB_B}",`).jobId === JOB_B, 'identity extraction must remain parser-independent');
    },
  },
  {
    name: 'handoff bridge: engine: preflight distinguishes stage supersession from code routing',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff({ stage: 'review' }) });
      assert(classifySubmission({ response: JSON.stringify({ jobId: JOB_A, stage: 'resume', handoffCode: 'HANDOFF-A' }), lane }) === 'superseded', 'wrong stage must supersede');
    },
  },
  {
    name: 'handoff bridge: engine: preflight accepts large syntax-broken output and caps bytes not characters',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      assert(classifySubmission({ response: `{${'x'.repeat(30 * 1024)}`, lane }) === 'pass', 'large broken model output must reach app validator');
      assert(Buffer.byteLength('λ'.repeat(600_000), 'utf8') > MAX_RESPONSE_BYTES, 'fixture must exceed byte cap');
      assert(stringifySubmission({ value: 'x' }).ok, 'objects normalize only through JSON');
    },
  },
  {
    name: 'handoff bridge: engine: imported paste identity helpers and local drift pins remain stable',
    run: () => {
      assert(DUPLICATE_RESPONSE_MIN_CHARS === 400, 'duplicate threshold must be imported and pinned');
      assert(typeof normalizePastedResponse === 'function' && typeof responseFingerprint === 'function', 'identity helpers must be imported');
      assert(APPLICATION_FENCE_RE.test('```json\n{}\n```'), 'fence regex drifted');
      assert(MAX_RESPONSE_BYTES === 1_000_000, 'frozen byte cap drifted');
      assert(trimHandoffCode(' "`HANDOFF-A`" ') === 'HANDOFF-A', 'code trim must remove only edge wrappers');
      assert(trimHandoffCode(`x${'a'.repeat(513)}`).length === 514, 'oversized code must not normalize around cap');
    },
  },
  {
    name: 'handoff bridge: engine: duplicate fingerprints block only a different accepted lane',
    run: () => {
      const first = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      const second = createApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, handoff: handoff({ jobId: JOB_B, code: 'HANDOFF-B' }) });
      const text = JSON.stringify({ jobId: JOB_B, stage: 'resume', handoffCode: 'HANDOFF-B', text: 'z'.repeat(500) });
      second.acceptedFingerprints.add(responseFingerprint(text));
      assert(classifySubmission({ response: text, lane: second, lanes: [first, second] }) === 'pass', 'same lane replay belongs to app routing');
      assert(classifySubmission({ response: text, lane: first, lanes: [first, second] }) === 'misrouted', 'different accepted lane must block fingerprint');
    },
  },
  {
    name: 'handoff bridge: engine: correction framing clips paths quoted spans and item volume safely',
    run: () => {
      const firstQuoted = 'q'.repeat(500);
      const secondQuoted = 's'.repeat(201);
      const quoted = `bad "${firstQuoted}" and '${secondQuoted}' at /Users/Marisol/private.json`;
      const framed = frameCorrections(Array(32).fill(quoted));
      assert(framed.validationErrors.length === 30, 'corrections cap at 30');
      assert(framed.validationErrors[0].includes('…') && !framed.validationErrors[0].includes('/Users/Marisol'), 'quoted spans and paths must scrub');
      assert(framed.correctionPrompt.includes(`"${firstQuoted.slice(0, 200)}…"`) && framed.correctionPrompt.includes(`'${secondQuoted.slice(0, 200)}…'`),
        'generated correction prompts must clip every overlong quoted span');
      const supplied = frameCorrections(['fix it'], quoted);
      assert(supplied.correctionPrompt.includes(`"${firstQuoted.slice(0, 200)}…"`) && supplied.correctionPrompt.includes(`'${secondQuoted.slice(0, 200)}…'`)
        && !supplied.correctionPrompt.includes(firstQuoted) && !supplied.correctionPrompt.includes(secondQuoted),
      'supplied app correction prompts must receive the same quoted-span clip after path scrubbing');
      assert(supplied.correctionPrompt.split(REJECTED_CAUTION).length === 2,
        'a supplied correction prompt must carry the fixed untrusted-evidence caution exactly once');
      const duplicateCaution = frameCorrections(['fix it'], `${REJECTED_CAUTION}\nRepair the field.\n${REJECTED_CAUTION}`);
      assert(duplicateCaution.correctionPrompt.split(REJECTED_CAUTION).length === 2,
        'an app-supplied caution must be de-duplicated rather than amplified');
      assert(clipCorrectionItem('x'.repeat(1600)).length === 1500, 'long correction must use exact 1500 clip');
    },
  },
  {
    name: 'handoff bridge: engine: rejected framing always includes fixed caution and paired correction prompt',
    run: () => {
      const body = makeRejectedBody({ handoffCode: 'HANDOFF-A', validationErrors: ['fix it'] });
      assert(body.caution === REJECTED_CAUTION && body.note === RESULT_NOTES.rejected, 'caution and measured note must be separate fixed fields');
      assert(Array.isArray(body.validationErrors) && typeof body.correctionPrompt === 'string', 'errors never travel without correction prompt');
      const empty = makeRejectedBody({ handoffCode: 'HANDOFF-A', validationErrors: [] });
      assert(!Object.hasOwn(empty, 'validationErrors') && !Object.hasOwn(empty, 'correctionPrompt'), 'empty corrections must not fabricate partial frame');
    },
  },
  {
    name: 'handoff bridge: engine: served application bodies use frozen directive wording',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() });
      const body = makeServedBody({ lane, remaining: { ready: 0, working: 0, needsYou: 0 } });
      assert(body.instructions === APPLICATION_INSTRUCTIONS && body.instructions.includes('submit_handoff'), 'application instructions must remain byte-stable directive text');
    },
  },
  {
    name: 'handoff bridge: engine: lane phases codes tombstones and human advance are bounded',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff(), codeGuard });
      assert(lane.phase === 'awaiting' && isHumanAdvance(lane, 'HUMAN-CODE', codeGuard), 'fresh human code must be recognized');
      lane.issuedCodes.set(codeGuard.key('OLD-CODE'), codeGuard.digest('OLD-CODE')); assert(!isHumanAdvance(lane, 'OLD-CODE', codeGuard), 'bridge-issued codes are not human advance');
      holdLane(lane, 'user_hold', 1); assert(lane.phase === 'held' && lane.heldFrom === 'awaiting', 'hold must retain resumable phase');
      resumeLane(lane); assert(lane.phase === 'awaiting' && lane.reason === null, 'resume must restore phase');
      const tombstones = new Map(); tombstoneCode(tombstones, 'HANDOFF-A', 'accepted', {}, undefined, codeGuard); assert(tombstones.get(codeGuard.key('HANDOFF-A')).reason === 'accepted', 'tombstone must retain route');
    },
  },
  {
    name: 'handoff bridge: engine: code guard uses fixed digests for wrapped, case, and same-prefix routes',
    run: () => {
      const digest = codeGuard.digest('HANDOFF-ABCDEF');
      assert(Buffer.isBuffer(digest) && digest.length === 32, 'routing identity must be a fixed SHA-256 digest');
      assert(codeGuard.equal(' \u201c`HANDOFF-ABCDEF`\u201d ', 'HANDOFF-ABCDEF'), 'ASCII and curly edge wrappers canonicalize before comparison');
      const multibyteAtCharacterCap = `\u201c${'\u00e9'.repeat(510)}\u201d`;
      const oversized = `\u201c${'x'.repeat(511)}\u201d`;
      assert(trimHandoffCode(multibyteAtCharacterCap) === '\u00e9'.repeat(510) && trimHandoffCode(oversized) === oversized && !codeGuard.equal(oversized, 'x'.repeat(511)), 'the 512-character cap normalizes multibyte input while an over-cap wrapper remains exact before validation');
      assert(!codeGuard.equal('HANDOFF-ABCDEF', 'HANDOFF-ABCDEG') && !codeGuard.equal('HANDOFF-ABCDEF', 'handoff-abcdef'), 'same-prefix and lower-case application codes remain distinct');
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff({ code: 'HANDOFF-ABCDEF' }), codeGuard });
      const direct = lane.issuedCodes.get(codeGuard.key('HANDOFF-ABCDEF'));
      assert(codeGuard.sameDigest(digest, direct) && !codeGuard.sameDigest(codeGuard.digest('HANDOFF-ABCDEG'), direct), 'issued-code Map entries retain digest evidence instead of raw codes');
    },
  },
  {
    name: 'handoff bridge: engine: wrapped app code routes, while lower-case and same-prefix inputs do not',
    run: async () => {
      const state = await served({ sourceOverrides: { read: async () => ({ kind: 'open', handoff: handoff({ code: 'HANDOFF-ABCDEF' }) }) } });
      const wrongCase = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'handoff-abcdef', response: answer({ code: 'HANDOFF-ABCDEF' }) });
      const samePrefix = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'HANDOFF-ABCDEG', response: answer({ code: 'HANDOFF-ABCDEF' }) });
      const accepted = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: ' `HANDOFF-ABCDEF` ', response: answer({ code: 'HANDOFF-ABCDEF' }) });
      assert(wrongCase.status === 'unknown_handoff' && samePrefix.status === 'unknown_handoff' && accepted.status === 'accepted', 'only the wrapped exact application route may reach the source');
    },
  },
  {
    name: 'handoff bridge: engine: chat keys are fixed-length and lanes count serving states',
    run: () => {
      const key = makeChatKey(() => Buffer.alloc(26, 0));
      assert(key.length === 26 && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/.test(key), 'chat key alphabet and length must be frozen');
      const lanes = [createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff() }), createApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B })];
      holdLane(lanes[1], 'user_hold'); assert(JSON.stringify(remainingCounts(lanes)) === JSON.stringify({ ready: 1, working: 0, needsYou: 1 }), 'queue counts must hide identifiers');
    },
  },
  {
    name: 'handoff bridge: engine: get is session fenced and a new epoch is memory-only',
    run: async () => {
      const { engine, session } = await started();
      assert((await engine.get({ session: 'wrong', linkId: LINK })).status === 'unauthorized', 'live wrong key must be uniform unauthorized');
      assert((await engine.get({ session, linkId: 'other-link' })).status === 'unauthorized', 'same key under another link must fail');
      assert(engine.snapshot().chat.state === 'awaiting-first-call' && !JSON.stringify(engine.snapshot()).includes(session), 'snapshot must not contain chat key');
    },
  },
  {
    name: 'handoff bridge: engine: status snapshot projects only the closed queue and chat vocabulary',
    run: async () => {
      const state = await served();
      const snapshot = state.engine.snapshot();
      const job = snapshot.queue.jobs[0];
      assert(job.jobId === JOB_A && job.phase === 'awaiting' && job.stage === 'resume' && job.servedToChat === 1 && Number.isSafeInteger(job.changedAt), 'controller status needs safe canonical lane facts');
      assert(snapshot.chat.state === 'working' && snapshot.chat.calls === 1 && snapshot.chat.outstanding?.stage === 'resume' && snapshot.chat.outstanding?.kind === 'application', 'chat status must expose only closed observability fields');
      const text = JSON.stringify(snapshot);
      assert(!text.includes(state.session) && !text.includes(PATH_A) && !text.includes('HANDOFF-A') && !text.includes('Synthetic application prompt'), 'engine status must never expose secret or content-bearing lane fields');
    },
  },
  {
    name: 'handoff bridge: engine: scoring status totals discovered hubs but counts only served work as with-chat',
    run: () => {
      const keyA = 'a'.repeat(64); const keyB = 'b'.repeat(64);
      const engine = createHandoffEngine({
        source: source().api,
        sources: { application: source().api, push: { get: async () => ({ status: 'queue_empty' }), submit: async () => ({ status: 'unknown_handoff' }), status: () => ({ served: 1, discovered: [{ key: keyA, pending: 2, tasks: [{ task: 'job-scoring', pending: 2 }] }, { key: keyB, pending: 3, tasks: [{ task: 'job-scoring', pending: 3 }] }] }) } },
      });
      const scoring = engine.snapshot().queue.scoring;
      assert(scoring.pending === 5 && scoring.withChat === 1 && scoring.tasks[0]?.pending === 5, 'discovery and served counts must not be conflated');
    },
  },
  {
    name: 'handoff bridge: engine: absent and retired epochs return session ended without burst accounting',
    run: async () => {
      const fake = source(); const clock = createFakeClock(); const engine = createHandoffEngine({ source: fake.api, now: clock.now, timers: clock });
      for (let index = 0; index < 7; index++) assert((await engine.get({ session: `old-${index}`, linkId: LINK })).status === 'session_ended', 'no epoch must not count stale key');
      const chat = await engine.newChat({ linkId: LINK }); await engine.continueChat({ linkId: LINK });
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'session_ended', 'rotation must retire old epoch');
      assert((await engine.get({ session: chat.sessionCode, linkId: 'other-link' })).status === 'unauthorized',
        'a retired epoch digest must remain bound to its original link identity');
      assert(engine.snapshot().pauseCause === null, 'old/no epoch requests cannot cause anomaly pause');
    },
  },
  {
    name: 'handoff bridge: engine: five bad live keys trigger anomaly pause',
    run: async () => {
      const { engine, session } = await started();
      for (let index = 0; index < 4; index++) assert((await engine.get({ session: `wrong-${index}`, linkId: LINK })).status === 'unauthorized', 'wrong live key must be unauthorized');
      assert((await engine.get({ session: 'wrong-last', linkId: LINK })).status === 'unauthorized', 'fifth response remains uniform');
      assert((await engine.get({ session, linkId: LINK })).status === 'paused' && engine.snapshot().pauseCause === 'anomaly', 'burst must pause after its uniform response');
    },
  },
  {
    name: 'handoff bridge: engine: released lanes schedule depth-first and get is idempotent',
    run: async () => {
      const { engine, session, fake } = await started(); await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const first = await engine.get({ session, linkId: LINK }); const second = await engine.get({ session, linkId: LINK });
      assert(first.status === 'served' && second.status === 'served' && first.handoffCode === second.handoffCode, 'outstanding lane must re-serve before later release');
      assert(fake.calls.read === 1, 'idempotent serve must not re-read prompt');
    },
  },
  {
    name: 'handoff bridge: engine: accepted submission completes a lane and leaves no stale prompt',
    run: async () => {
      const { engine, session, result } = await served();
      const reply = await engine.submit({ session, linkId: LINK, handoffCode: result.handoffCode, response: answer({ code: result.handoffCode, stage: result.stage }) });
      assert(reply.status === 'accepted' && reply.jobComplete === true, 'completion acceptance must not invent next prompt');
      assert((await engine.get({ session, linkId: LINK })).status === 'waiting', 'host lane must not re-serve stale prompt');
    },
  },
  {
    name: 'handoff bridge: engine: accepted completed submit notifies its owner once and contains callback throws',
    run: async () => {
      const changes = [];
      const state = await served({ engineOptions: { onJobChanged: payload => { changes.push(payload); throw new Error('advisory callback failure'); } } });
      const result = await state.engine.submit({
        session: state.session,
        linkId: LINK,
        handoffCode: state.result.handoffCode,
        response: answer({ code: state.result.handoffCode, stage: state.result.stage }),
      });
      assert(result.status === 'accepted' && result.jobComplete === true, 'callback failure must not change completed acceptance');
      assert(changes.length === 1 && JSON.stringify(changes[0]) === JSON.stringify({ jobId: JOB_A, canvasFilePath: PATH_A }), 'completed bridge mutation must notify its owning UI once with the canonical job payload');
    },
  },
  {
    name: 'handoff bridge: engine: accepted successor submit notifies its owner once after mutation',
    run: async () => {
      const changes = [];
      const state = await served({
        sourceOverrides: { submit: async () => ({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-NEXT', revision: 2 }) }) },
        engineOptions: { onJobChanged: payload => changes.push(payload) },
      });
      const result = await state.engine.submit({
        session: state.session,
        linkId: LINK,
        handoffCode: state.result.handoffCode,
        response: answer({ code: state.result.handoffCode, stage: state.result.stage }),
      });
      assert(result.status === 'accepted' && result.jobComplete === false, 'successor acceptance must remain successful');
      assert(changes.length === 1 && JSON.stringify(changes[0]) === JSON.stringify({ jobId: JOB_A, canvasFilePath: PATH_A }), 'successor bridge mutation must notify its owning UI once with the canonical job payload');
    },
  },
  {
    name: 'handoff bridge: engine: observations, rejection, errors, held lanes, and human advance never notify owners',
    run: async () => {
      const observed = [];
      const observation = await started({
        sourceOverrides: { read: async () => ({ kind: 'host' }), status: async () => ({ kind: 'host' }) },
        engineOptions: { onJobChanged: payload => observed.push(payload) },
      });
      await observation.engine.get({ session: observation.session, linkId: LINK });
      observation.clock.advance(CONSTANTS.HOST_POLL_MS);
      await observation.engine.get({ session: observation.session, linkId: LINK });
      assert(observed.length === 0, 'source reads and host status observations must not notify an owner');

      const rejectedChanges = [];
      const rejected = await served({
        sourceOverrides: { submit: async () => ({ kind: 'rejected', handoff: handoff(), validationErrors: ['synthetic invalid'] }) },
        engineOptions: { onJobChanged: payload => rejectedChanges.push(payload) },
      });
      await rejected.engine.submit({ session: rejected.session, linkId: LINK, handoffCode: rejected.result.handoffCode, response: answer({ code: rejected.result.handoffCode, stage: rejected.result.stage }) });
      assert(rejectedChanges.length === 0, 'rejected submits must not notify an owner');

      const erroredChanges = [];
      const errored = await served({
        sourceOverrides: { submit: async () => ({ kind: 'threw', code: 'LOCAL_AI_JOB_INTEGRITY' }) },
        engineOptions: { onJobChanged: payload => erroredChanges.push(payload) },
      });
      await errored.engine.submit({ session: errored.session, linkId: LINK, handoffCode: errored.result.handoffCode, response: answer({ code: errored.result.handoffCode, stage: errored.result.stage }) });
      await errored.engine.hold(JOB_A);
      assert(erroredChanges.length === 0, 'error and held transitions must not notify an owner');

      const humanChanges = [];
      let reads = 0;
      const humanAdvance = await served({
        sourceOverrides: { read: async () => ({ kind: 'open', handoff: handoff({ code: ++reads === 1 ? 'HANDOFF-A' : 'HUMAN-NEW' }) }) },
        engineOptions: { onJobChanged: payload => humanChanges.push(payload) },
      });
      humanAdvance.engine.hint({ jobId: JOB_A });
      await humanAdvance.engine.get({ session: humanAdvance.session, linkId: LINK });
      assert(humanChanges.length === 0, 'human advance holds must not notify an owner');
    },
  },
  {
    name: 'handoff bridge: engine: verdict cache attaches concurrent submits with one source call',
    run: async () => {
      const pending = deferred(); let submits = 0;
      const state = await served({ sourceOverrides: { submit: async () => { submits++; return pending.promise; } } });
      const body = answer({ code: state.result.handoffCode, stage: state.result.stage });
      const one = state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: body });
      const two = state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: body });
      await Promise.resolve(); pending.resolve({ kind: 'accepted', completed: true }); const [left, right] = await Promise.all([one, two]);
      assert(left.status === 'accepted' && right.status === 'accepted' && submits === 1, 'identical verdicts must attach to one app submit');
    },
  },
  {
    name: 'handoff bridge: engine: accepted and rotated tombstones distinguish duplicate and superseded',
    run: async () => {
      const state = await served(); const body = answer({ code: state.result.handoffCode, stage: state.result.stage });
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: body });
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: body })).status === 'duplicate', 'accepted retired code must take duplicate route');
      const rotated = await served({ sourceOverrides: { submit: async () => ({ kind: 'rejected', handoff: handoff({ code: 'HANDOFF-ROTATED' }), validationErrors: ['fix'] }) } });
      const rejected = await rotated.engine.submit({ session: rotated.session, linkId: LINK, handoffCode: rotated.result.handoffCode, response: answer({ code: rotated.result.handoffCode, stage: rotated.result.stage }) });
      assert(rejected.status === 'rejected' && (await rotated.engine.submit({ session: rotated.session, linkId: LINK, handoffCode: rotated.result.handoffCode, response: '{}' })).status === 'superseded', 'rotated stale code must supersede');
    },
  },
  {
    name: 'handoff bridge: engine: codes route solely through memory index and never envelope fallback',
    run: async () => {
      const state = await served();
      const response = JSON.stringify({ jobId: JOB_A, stage: 'resume', handoffCode: 'NOT-IN-INDEX', text: 'x'.repeat(100) });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'NOT-IN-INDEX', response });
      assert(result.status === 'unknown_handoff' && state.fake.calls.submit === 0, 'real lane identity cannot bypass missing code index');
    },
  },
  {
    name: 'handoff bridge: engine: same-code rejected verdict replays from cache without second source call',
    run: async () => {
      let submits = 0;
      const state = await served({ sourceOverrides: { submit: async () => { submits++; return { kind: 'rejected', handoff: handoff(), validationErrors: ['synthetic invalid'] }; } } });
      const response = answer({ code: state.result.handoffCode, stage: state.result.stage });
      const first = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response });
      const second = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response });
      assert(first.status === 'rejected' && second.status === 'rejected' && submits === 1, 'same-code rejected verdict must replay without a second app call');
    },
  },
  {
    name: 'handoff bridge: engine: response byte cap and junk cap fail before source submission',
    run: async () => {
      const state = await served(); assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: 'λ'.repeat(600_000) })).status === 'too_large', 'byte overage must reject');
      for (let index = 0; index < 5; index++) await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: '{}' });
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) })).status === 'held', 'five junk responses must cap lane');
      assert(state.fake.calls.submit === 0, 'invalid submissions never call source');
    },
  },
  {
    name: 'handoff bridge: engine: rejection cap holds after six app rejections',
    run: async () => {
      const state = await served({ sourceOverrides: { submit: async () => ({ kind: 'rejected', handoff: handoff(), validationErrors: ['synthetic invalid'] }) } });
      let final;
      for (let index = 0; index < 6; index++) final = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage, extra: { n: index } }) });
      assert(final.status === 'held' && final.reason === 'rejection_cap', 'six rejections must hold');
    },
  },
  {
    name: 'handoff bridge: engine: human advance is held automatically instead of overwritten',
    run: async () => {
      let reads = 0;
      const state = await served({ sourceOverrides: { read: async () => { reads++; return { kind: 'open', handoff: handoff({ code: reads === 1 ? 'HANDOFF-A' : 'HUMAN-NEW' }) }; } } });
      state.engine.hint({ jobId: JOB_A }); state.clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS); await Promise.resolve();
      const next = await state.engine.get({ session: state.session, linkId: LINK });
      assert(next.status === 'paused' && next.reason === 'needs_user', 'unissued human code must require review');
    },
  },
  {
    name: 'handoff bridge: engine: soft job cap sessions full only when another lane is ready',
    run: async () => {
      const { engine, session, clock } = await started({ sourceOverrides: { status: async () => ({ kind: 'done' }) }, engineOptions: { limits: { jobsPerChat: 1 } } }); await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const first = await engine.get({ session, linkId: LINK }); await engine.submit({ session, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
      clock.advance(CONSTANTS.HOST_POLL_MS);
      await engine.get({ session, linkId: LINK });
      assert((await engine.get({ session, linkId: LINK })).status === 'session_full', 'next ready lane must observe per-chat cap');
    },
  },
  {
    name: 'handoff bridge: engine: hard byte budget stops serving before any prompt read',
    run: async () => {
      const { engine, session } = await started({ engineOptions: { limits: { epochHardBytes: 0 } } });
      assert((await engine.get({ session, linkId: LINK })).status === 'session_full', 'hard byte budget must fence before source read');
    },
  },
  {
    name: 'handoff bridge: engine: an accepted application successor cannot bypass the hard byte budget',
    run: async () => {
      const response = answer({ extra: { text: 'x'.repeat(12_000) } });
      let reads = 0;
      const state = await served({
        sourceOverrides: {
          read: async () => ({
            kind: 'open',
            handoff: handoff({
              code: ++reads === 1 ? 'HANDOFF-A' : 'HANDOFF-APPLICATION-RESUMED',
              revision: reads,
              prompt: 'Synthetic resumed application prompt.',
            }),
          }),
          submit: async () => ({
            kind: 'accepted',
            completed: false,
            handoff: handoff({ code: 'HANDOFF-APPLICATION-RESUMED', revision: 2, prompt: 'Synthetic resumed application prompt.' }),
          }),
        },
        engineOptions: { limits: { epochHardBytes: 10_000 } },
      });
      const accepted = await state.engine.submit({
        session: state.session,
        linkId: LINK,
        handoffCode: state.result.handoffCode,
        response,
      });
      assert(accepted.status === 'accepted' && accepted.next?.status === 'session_full',
        'an accepted application commit may finish, but its inline successor must hit the hard budget fence');
      const full = state.engine.snapshot();
      assert(reads === 1 && full.counts.getServed === 1 && full.chat.bytesReceived >= 12_000,
        'the fenced inline successor must not read or charge a second application prompt');
      assert((await state.engine.get({ session: state.session, linkId: LINK })).status === 'session_full',
        'the original full chat must not serve the successor on a later poll');
      const resumed = await state.engine.newChat({ linkId: LINK });
      const next = await state.engine.get({ session: resumed.sessionCode, linkId: LINK });
      assert(next.status === 'served' && next.kind === 'application',
        'a replacement chat must be able to resume application work with a fresh epoch budget');
    },
  },
  {
    name: 'handoff bridge: engine: an accepted push successor cannot bypass the hard byte budget',
    run: async () => {
      let gets = 0; let successors = 0;
      const push = {
        async get() {
          gets++;
          return {
            status: 'served',
            handoffCode: gets === 1 ? 'PUSH-HARD-BUDGET-A' : 'PUSH-HARD-BUDGET-RESUMED',
            task: 'job-scoring',
            prompt: 'Synthetic scoring prompt.',
            promptBytes: 1,
            remaining: { ready: 0, working: 0, needsYou: 0 },
          };
        },
        async submit() { return { status: 'accepted' }; },
        async nextAfterAccept() {
          successors++;
          return {
            status: 'served',
            handoffCode: 'PUSH-HARD-BUDGET-SUCCESSOR',
            task: 'job-scoring',
            prompt: 'Synthetic successor scoring prompt.',
            promptBytes: 1,
            remaining: { ready: 0, working: 0, needsYou: 0 },
          };
        },
      };
      const engine = createHandoffEngine({
        sources: { application: source().api, push },
        scope: { applications: false, scoring: true },
        holdMs: 0,
        limits: { epochHardBytes: 100 },
      });
      const chat = await engine.newChat({ linkId: LINK });
      const first = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(first.status === 'served' && first.kind === 'push', 'fixture must first serve the synthetic scoring handoff');
      const accepted = await engine.submit({
        session: chat.sessionCode,
        linkId: LINK,
        handoffCode: first.handoffCode,
        response: 'y'.repeat(128),
      });
      assert(accepted.status === 'accepted' && accepted.next?.status === 'session_full',
        'an accepted push commit may finish, but its inline successor must hit the hard budget fence');
      const full = engine.snapshot();
      assert(gets === 1 && successors === 1 && full.counts.getServed === 1 && full.chat.bytesServed === 1 && full.chat.bytesReceived === 128,
        'the fenced inline successor must not be charged or counted as a second served push prompt');
      assert((await engine.get({ session: chat.sessionCode, linkId: LINK })).status === 'session_full',
        'the original full chat must not serve the push successor on a later poll');
      const resumed = await engine.newChat({ linkId: LINK });
      const next = await engine.get({ session: resumed.sessionCode, linkId: LINK });
      assert(next.status === 'served' && next.handoffCode === 'PUSH-HARD-BUDGET-RESUMED' && gets === 2,
        'a replacement chat must be able to resume scoring work with a fresh epoch budget');
    },
  },
  {
    name: 'handoff bridge: engine: idle pause measures human actions rather than authenticated polling',
    run: async () => {
      const state = await served({ engineOptions: { limits: { idlePauseMinutes: 1 } } }); state.clock.advance(61_000);
      const paused = await state.engine.get({ session: state.session, linkId: LINK });
      assert(paused.status === 'paused' && paused.reason === 'idle', 'authenticated get must not renew human clock');
      assert((await state.engine.resume({})).ok && (await state.engine.get({ session: state.session, linkId: LINK })).status === 'served', 'one resume lifts pause');
    },
  },
  {
    name: 'handoff bridge: engine: queue empty closes an all-terminal epoch',
    run: async () => {
      const state = await served({ sourceOverrides: { status: async () => ({ kind: 'done' }) } }); await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) }); state.clock.advance(CONSTANTS.HOST_POLL_MS);
      assert((await state.engine.get({ session: state.session, linkId: LINK })).status === 'queue_empty', 'terminal queue must report drain first');
      assert((await state.engine.get({ session: state.session, linkId: LINK })).status === 'session_ended', 'drained epoch closes immediately after empty delivery');
    },
  },
  {
    name: 'handoff bridge: engine: empty publish never closes epoch with held or host work',
    run: async () => {
      const { engine, session } = await started({ sourceOverrides: { read: async () => ({ kind: 'host' }) } });
      assert((await engine.get({ session, linkId: LINK })).status === 'waiting', 'host work is not queue empty');
      await engine.hold(JOB_A); assert((await engine.get({ session, linkId: LINK })).status === 'paused', 'held work is not queue empty');
    },
  },
  {
    name: 'handoff bridge: engine: restart confirm gates exactly first post-restore mint',
    run: async () => {
      const restoredLanes = [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 0, phase: 'unread' }]; let confirms = 0; const fake = source(); const clock = createFakeClock();
      const engine = createHandoffEngine({ source: fake.api, restoredLanes, now: clock.now, timers: clock, confirmRestart: async () => { confirms++; return true; } });
      assert((await engine.newChat({ linkId: LINK })).copied && (await engine.continueChat({ linkId: LINK })).copied && confirms === 1, 'restart confirmation must be once per launch');
    },
  },
  {
    name: 'handoff bridge: engine: overlapping prepared chats reserve distinct ordinals and push epochs',
    run: async () => {
      const epochs = [];
      const push = {
        async get({ epoch }) {
          epochs.push(epoch);
          return { status: 'served', handoffCode: `PUSH-${epoch}`, task: 'job-scoring', prompt: 'Synthetic scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit() { return { status: 'unknown_handoff' }; },
        closeEpoch() {},
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const [first, second] = await Promise.all([
        engine.prepareChat({ linkId: LINK, kind: 'new' }),
        engine.prepareChat({ linkId: LINK, kind: 'continue' }),
      ]);
      assert(first.copied && second.copied && first.chatOrdinal === 1 && second.chatOrdinal === 2,
        'overlapping preparations must reserve unique, monotonically increasing ordinals');
      assert(first.commit() === true, 'the first prepared capability must start epoch one');
      assert((await engine.get({ session: first.sessionCode, linkId: LINK })).status === 'served', 'epoch one must reach the push source');
      assert(second.commit() === true, 'the newer prepared capability must rotate to epoch two');
      assert((await engine.get({ session: second.sessionCode, linkId: LINK })).status === 'served'
        && JSON.stringify(epochs) === JSON.stringify(['epoch-1', 'epoch-2']),
      'separate prepared chats must never alias their push epoch id');
    },
  },
  {
    name: 'handoff bridge: engine: stale prepared commit cannot retire or mutate a newer live push epoch',
    run: async () => {
      const epochs = []; const closed = [];
      const push = {
        async get({ epoch }) {
          epochs.push(epoch);
          return { status: 'served', handoffCode: 'PUSH-ADA-EXAMPLE', task: 'job-scoring', prompt: 'Synthetic Ada scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit() { return { status: 'unknown_handoff' }; },
        closeEpoch(epoch) { closed.push(epoch); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const [older, newer] = await Promise.all([engine.prepareChat({ linkId: LINK }), engine.prepareChat({ linkId: LINK })]);
      assert(newer.commit() === true, 'the later prepared capability must be able to commit first');
      assert((await engine.get({ session: newer.sessionCode, linkId: LINK })).status === 'served' && JSON.stringify(epochs) === JSON.stringify(['epoch-2']),
        'the live later preparation must own epoch two');
      assert(older.commit() === false, 'an older prepared capability must refuse an out-of-order commit');
      const afterStale = engine.snapshot();
      assert(afterStale.chat.ordinal === 2 && closed.every(epoch => epoch !== 'epoch-2'),
        'a stale commit must not close or replace the live newer push epoch');
      assert((await engine.get({ session: newer.sessionCode, linkId: LINK })).status === 'served'
        && JSON.stringify(epochs) === JSON.stringify(['epoch-2', 'epoch-2']),
      'the newer session remains live after the refused stale commit');
    },
  },
  {
    name: 'handoff bridge: engine: overlapping restart preparations confirm and persist once',
    run: async () => {
      const confirmation = deferred(); let confirms = 0; let saves = 0;
      const engine = createHandoffEngine({
        source: source().api,
        restoredLanes: [{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 0, phase: 'unread' }],
        confirmRestart: async () => { confirms++; return confirmation.promise; },
        store: { saveLanes: async () => { saves++; return true; } },
      });
      const first = engine.prepareChat({ linkId: LINK });
      const second = engine.prepareChat({ linkId: LINK });
      await Promise.resolve();
      assert(confirms === 1 && saves === 0, 'overlapping preparations must share the one pending restart confirmation');
      confirmation.resolve(true);
      const [left, right] = await Promise.all([first, second]);
      assert(left.copied && right.copied && confirms === 1 && saves === 1,
        'one accepted restart confirmation must persist once before both preparations return');
    },
  },
  {
    name: 'handoff bridge: engine: restored ordinary lanes become restart holds while existing holds retain reason',
    run: () => {
      const plain = rehydrateApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, releasedAt: 0, phase: 'unread', counters: {} });
      const held = rehydrateApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B, releasedAt: 0, phase: 'held', reason: 'user_hold', heldFrom: 'awaiting', counters: {} });
      const needs = rehydrateApplicationLane({ ord: 3, jobId: '33333333-3333-4333-8333-333333333333', canvasFilePath: '/tmp/x.canvas', releasedAt: 0, phase: 'needs_user', reason: 'job_broken', heldFrom: 'awaiting', counters: {} });
      assert(plain.reason === 'restart' && held.reason === 'user_hold' && needs.reason === 'job_broken', 'rehydration preserves explicit holds');
    },
  },
  {
    name: 'handoff bridge: engine: hint coalescing invalidates one lane without multiple timers',
    run: async () => {
      const state = await served(); assert(state.engine.hint({ jobId: JOB_A }) && state.engine.hint({ jobId: JOB_A }), 'hints should be accepted');
      assert(state.clock.pendingCount() <= 1, 'coalesced hints must keep one timer'); state.clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS); await Promise.resolve(); await state.engine.get({ session: state.session, linkId: LINK });
      assert(state.fake.calls.read === 2, 'coalesced hint invalidates exactly one subsequent read');
    },
  },
  {
    name: 'handoff bridge: engine: release validates UUID paths deduplicates and enforces lane cap',
    run: async () => {
      const fake = source(); const engine = createHandoffEngine({ source: fake.api });
      assert((await engine.release({ jobs: [{ jobId: 'not-a-uuid', canvasFilePath: PATH_A }] })).code === 'invalid_arguments', 'invalid release must fail closed');
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }, { jobId: JOB_A, canvasFilePath: PATH_A }] })).count === 1, 'duplicate release must collapse');
      const jobs = Array.from({ length: 9 }, (_, index) => { const digit = (index + 3).toString(16); return { jobId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`, canvasFilePath: `/tmp/${index}.canvas` }; });
      assert((await engine.release({ jobs })).ok && (await engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] })).code === 'lane_limit', 'ten live lanes is hard cap');
    },
  },
  {
    name: 'handoff bridge: engine: power resume aborts a held get and refreshes stale awaiting state',
    run: async () => {
      const clock = createFakeClock();
      const state = await started({ clock, engineOptions: { holdMs: 10_000, limits: { jobsPerChat: 1 } } });
      await state.engine.release({ jobs: [{ jobId: JOB_B, canvasFilePath: PATH_B }] });
      const first = await state.engine.get({ session: state.session, linkId: LINK });
      const initialPower = state.engine.powerState();
      assert(initialPower.awaiting === true && initialPower.hostCanvasPaths.length === 0 && Number.isFinite(initialPower.lastCallAt)
        && JSON.stringify(Object.keys(initialPower).sort()) === JSON.stringify(['awaiting', 'hostCanvasPaths', 'lastCallAt']),
      'private power state must expose awaiting work without leaking lane metadata');
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: first.handoffCode, response: answer({ code: first.handoffCode, stage: first.stage }) });
      state.engine.hint({ jobId: JOB_B }); clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS);
      const held = state.engine.get({ session: state.session, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(state.engine.debugState().waiters === 1, 'second poll must be held before resume');
      assert(state.engine.onPowerResume(), 'resume fence must be accepted');
      const result = await held;
      assert(result.status === 'retry' && state.fake.calls.read === 2, 'pre-resume held get must wake retry without continuing source work');
      const lanes = state.engine.snapshot().queue.jobs;
      assert(lanes.some(lane => lane.jobId === JOB_B && lane.phase === 'awaiting'), 'resume must preserve the awaiting lane rather than serve stale work');
      const refreshed = state.engine.get({ session: state.session, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve)); clock.advance(10_000);
      assert((await refreshed).status === 'waiting' && state.fake.calls.read === 3, 'next get must refresh the invalidated awaiting lane');
    },
  },
  {
    name: 'handoff bridge: engine: power hooks stay active with keep-awake disabled and contain callbacks',
    run: () => {
      const listeners = new Map(); const removed = []; const calls = []; const callbackArgs = [];
      const monitor = {
        on(event, callback) { listeners.set(event, callback); },
        removeListener(event, callback) { removed.push([event, callback]); },
      };
      const power = createHandoffBridgePower({
        enabled: false,
        now: () => 123,
        powerMonitor: monitor,
        powerSaveBlocker: { start: () => calls.push('start'), stop: () => calls.push('stop') },
        getCanvasWindows: () => [{ webContents: { id: 7, setBackgroundThrottling: value => calls.push(value) } }],
        onSuspend: (...args) => callbackArgs.push(args),
        onResume: () => { throw new Error('synthetic callback'); },
      });
      assert(listeners.has('suspend') && listeners.has('resume'), 'lifecycle hooks must attach even while keep-awake is disabled');
      listeners.get('suspend')(); listeners.get('resume')();
      assert(callbackArgs.length === 1 && callbackArgs[0].length === 0, 'suspend timestamp must remain internal');
      assert(power.update({ hostLane: true, recentChat: true, hostWindowIds: [7] }) === false && calls.length === 0, 'false keep-awake must not touch blocker or throttling ports');
      power.dispose();
      assert(removed.length === 2 && removed.every(([event, callback]) => listeners.get(event) === callback), 'dispose must remove both lifecycle listeners');
    },
  },
  {
    name: 'handoff bridge: engine: concurrent get calls share one pending read and both serve it',
    run: async () => {
      const pending = deferred(); let reads = 0;
      const state = await started({ sourceOverrides: { read: async () => { reads++; return pending.promise; } } });
      const one = state.engine.get({ session: state.session, linkId: LINK }); const two = state.engine.get({ session: state.session, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve)); pending.resolve({ kind: 'open', handoff: handoff() });
      const [left, right] = await Promise.all([one, two]);
      assert(reads === 1 && left.status === 'served' && right.status === 'served', 'concurrent polls must attach to one source read');
    },
  },
  {
    name: 'handoff bridge: engine: watchdog frees an unsettled read slot for a later retry',
    run: async () => {
      let reads = 0; const never = new Promise(() => {}); const fake = source({ read: async () => (++reads === 1 ? never : { kind: 'open', handoff: handoff() }) });
      const timers = { setTimeout: (fn, ms) => ({ timer: setTimeout(fn, ms), unref() {} }), clearTimeout: handle => clearTimeout(handle?.timer ?? handle) };
      const engine = createHandoffEngine({ source: fake.api, timers, readWatchdogMs: 1, holdMs: 0, random: () => Buffer.alloc(26, 7) });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); const chat = await engine.newChat({ linkId: LINK });
      const result = await engine.get({ session: chat.sessionCode, linkId: LINK }); await engine.close();
      assert(reads === 2 && result.status === 'served', 'watchdog must free a stuck source slot and retry once');
    },
  },
  {
    name: 'handoff bridge: engine: zero submit budget returns retry while app submit continues',
    run: async () => {
      const pending = deferred(); const state = await served({ sourceOverrides: { submit: async () => pending.promise }, engineOptions: { submitBudgetMs: 0 } });
      const response = answer({ code: state.result.handoffCode, stage: state.result.stage });
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response })).status === 'retry', 'budget must return retry without aborting app call');
      pending.resolve({ kind: 'accepted', completed: true }); await new Promise(resolve => setImmediate(resolve));
      assert(state.engine.snapshot().counts.submitAccepted === 1, 'budgeted app submit must continue to its durable result');
    },
  },
  {
    name: 'handoff bridge: engine: held lane rejects submit and resume restores its awaiting prompt',
    run: async () => {
      const state = await served(); await state.engine.hold(JOB_A);
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: '{}' })).status === 'held', 'held lane must not submit');
      assert((await state.engine.resume({ jobId: JOB_A })).ok && (await state.engine.get({ session: state.session, linkId: LINK })).status === 'served', 'lane resume restores serving');
    },
  },
  {
    name: 'handoff bridge: engine: unrelease removes its in-memory code route',
    run: async () => {
      const state = await served(); assert((await state.engine.unrelease(JOB_A)).ok, 'unrelease should succeed');
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: '{}' })).status === 'unknown_handoff', 'unreleased code must lose index route');
    },
  },
  {
    name: 'handoff bridge: engine: serve-after-idle hook is rate limited and contains callback failures',
    run: async () => {
      let notices = 0; const clock = createFakeClock();
      const state = await started({ clock, engineOptions: { onServeAfterIdle: () => { notices++; throw new Error('synthetic callback'); } } });
      clock.advance(CONSTANTS.SERVE_AFTER_IDLE_NOTICE_HOURS * 3_600_000); await state.engine.get({ session: state.session, linkId: LINK }); await state.engine.get({ session: state.session, linkId: LINK });
      assert(notices === 1, 'idle notice must not repeat on an immediate re-serve');
    },
  },
  {
    name: 'handoff bridge: engine: application throw rereads and retries rather than exposing errors',
    run: async () => {
      let submits = 0;
      const state = await served({ sourceOverrides: { submit: async () => { submits++; return submits === 1 ? { kind: 'threw', code: 'EIO' } : { kind: 'accepted', completed: true }; } } });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      assert(result.status === 'accepted' && submits === 2, 'submit throw must re-read and retry safely');
    },
  },
  {
    name: 'handoff bridge: engine: same-stage fresh recovery code retries once and supersedes old code',
    run: async () => {
      let reads = 0; const submittedCodes = [];
      const state = await served({ sourceOverrides: {
        read: async () => ({ kind: 'open', handoff: handoff({ code: ++reads === 1 ? 'HANDOFF-A' : 'HANDOFF-FRESH', stage: 'resume' }) }),
        submit: async (_lane, submitted) => { submittedCodes.push(submitted.code); return submittedCodes.length === 1 ? { kind: 'threw', code: 'EIO', stage: 'resume' } : { kind: 'accepted', completed: true }; },
      } });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      assert(result.status === 'accepted' && submittedCodes.join(',') === 'HANDOFF-A,HANDOFF-FRESH', 'same-stage recovery must retry exactly once with fresh code');
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: 'HANDOFF-A', response: '{}' })).status === 'superseded', 'old recovery code must become superseded');
    },
  },
  {
    name: 'handoff bridge: engine: different-stage fresh recovery code holds human advance without retry',
    run: async () => {
      let reads = 0; let submits = 0;
      const state = await served({ sourceOverrides: {
        read: async () => ({ kind: 'open', handoff: handoff({ code: ++reads === 1 ? 'HANDOFF-A' : 'HANDOFF-REVIEW', stage: reads === 1 ? 'resume' : 'review' }) }),
        submit: async () => { submits++; return { kind: 'threw', code: 'EIO', stage: 'resume' }; },
      } });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      const lane = state.engine.snapshot().queue.jobs[0];
      assert(result.status === 'superseded' && submits === 1, 'stage change must return superseded without retrying submit');
      assert(lane.phase === 'held' && lane.reason === 'human_advance', 'stage-changing fresh code must require human review');
    },
  },
  {
    name: 'handoff bridge: engine: integrity faults become fixed needs-user result without source text',
    run: async () => {
      const state = await served({ sourceOverrides: { submit: async () => ({ kind: 'threw', code: 'LOCAL_AI_JOB_INTEGRITY', message: '/private/secret' }) } });
      const result = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      assert(result.status === 'needs_user' && result.reason === 'job_broken' && !JSON.stringify(result).includes('/private'), 'integrity error must be fixed and private');
    },
  },
  {
    name: 'handoff bridge: engine: review rounds cap at eight accepted revisions',
    run: async () => {
      let revision = 0;
      const state = await served({ sourceOverrides: { submit: async () => ({ kind: 'accepted', completed: false, handoff: handoff({ code: 'HANDOFF-A', stage: 'review', revision: ++revision }) }) } });
      let code = state.result.handoffCode; let final;
      for (let index = 0; index < 9; index++) { final = await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: code, response: answer({ code, stage: index ? 'review' : state.result.stage, extra: { index } }) }); code = final.next?.handoffCode ?? code; }
      assert(final.status === 'held' && final.reason === 'review_round_cap', 'review rounds must stop at frozen cap');
    },
  },
  {
    name: 'handoff bridge: engine: persisted metadata rejects selected hub and code fields',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory });
        assert(!(await store.saveLanes([{ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, phase: 'held', reason: 'user_hold', heldFrom: 'awaiting', counters: {}, selectedHub: 'hub' }])), 'selected hubs are never durable lane fields');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: close retires the live epoch and cancels hint timers',
    run: async () => {
      const state = await served(); state.engine.hint({ jobId: JOB_A }); await state.engine.close();
      assert(state.clock.pendingCount() === 0 && (await state.engine.get({ session: state.session, linkId: LINK })).status === 'paused', 'close must clear timers and stop calls');
    },
  },
  {
    name: 'handoff bridge: engine: fresh corrections send the fixed note before correction prompt',
    run: () => {
      const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: { ...handoff(), corrections: ['fix synthetic field'], correctionPrompt: 'private app prompt' } });
      const body = makeServedBody({ lane, remaining: { ready: 1, working: 0, needsYou: 0 }, servedBefore: false });
      assert(typeof body.note === 'string' && !Object.hasOwn(body, 'correctionPrompt'), 'first fresh correction uses fixed framing note only');
    },
  },
  {
    name: 'handoff bridge: engine: ENOENT status becomes canvas-unavailable needs-user lane',
    run: async () => {
      const state = await served({ sourceOverrides: { status: async () => ({ kind: 'threw', code: 'ENOENT' }) } });
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) }); state.clock.advance(CONSTANTS.HOST_POLL_MS);
      await state.engine.get({ session: state.session, linkId: LINK });
      const lane = state.engine.snapshot().queue.jobs[0]; assert(lane.phase === 'needs_user' && lane.reason === 'canvas_unavailable', 'missing canvas must never be silently retried');
    },
  },
  {
    name: 'handoff bridge: engine: an unsettled submit is held submit-stuck at ninety seconds',
    run: async () => {
      const pending = deferred(); const state = await served({ sourceOverrides: { submit: async () => pending.promise }, engineOptions: { submitBudgetMs: 0 } });
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) }); await new Promise(resolve => setImmediate(resolve)); state.clock.advance(CONSTANTS.SUBMIT_STUCK_MS); await new Promise(resolve => setImmediate(resolve));
      const lane = state.engine.snapshot().queue.jobs[0]; assert(lane.phase === 'needs_user' && lane.reason === 'submit_stuck', 'unsettled app submit must be visibly held'); pending.resolve({ kind: 'accepted', completed: true });
    },
  },
  {
    name: 'handoff bridge: engine: an unsettled internal recovery submit releases its semaphore slot',
    run: async () => {
      const pending = deferred(); let submits = 0;
      const state = await served({
        sourceOverrides: { submit: async () => (++submits === 1 ? { kind: 'threw', code: 'EIO' } : pending.promise) },
        engineOptions: { submitBudgetMs: 0 },
      });
      await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: answer({ code: state.result.handoffCode, stage: state.result.stage }) });
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert(state.engine.debugState().submitActive === 1, 'internal recovery must hold the submit slot while it is pending');
      state.clock.advance(CONSTANTS.SUBMIT_STUCK_MS);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      const lane = state.engine.snapshot().queue.jobs[0];
      assert(lane.phase === 'needs_user' && lane.reason === 'submit_stuck', 'internal recovery timeout must hold the lane visibly');
      assert(state.engine.debugState().submitActive === 0 && state.engine.debugState().submitWaiting === 0, 'internal recovery timeout must release the semaphore');
      pending.resolve({ kind: 'accepted', completed: true });
    },
  },
  {
    name: 'handoff bridge: engine: different bytes replay retained crash-gap bytes before a new answer',
    run: async () => {
      const submitted = [];
      const state = await served({ sourceOverrides: {
        submit: async (_lane, value) => {
          submitted.push(value.text);
          return submitted.length < 4 ? { kind: 'threw', code: 'EIO' } : { kind: 'accepted', completed: true };
        },
      } });
      const first = answer({ code: state.result.handoffCode, stage: state.result.stage, extra: { version: 1 } });
      const second = answer({ code: state.result.handoffCode, stage: state.result.stage, extra: { version: 2 } });
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: first })).status === 'retry', 'exhausted crash-gap recovery must ask for a retry');
      assert((await state.engine.submit({ session: state.session, linkId: LINK, handoffCode: state.result.handoffCode, response: second })).status === 'accepted', 'retained crash-gap bytes should recover before accepting replacement bytes');
      assert(submitted.length === 4 && submitted.every(value => value === first), 'replacement bytes must not overtake retained crash-gap bytes');
    },
  },
  {
    name: 'handoff bridge: engine: failed persistence rolls release state back atomically',
    run: async () => {
      const fake = source(); const engine = createHandoffEngine({ source: fake.api, store: { saveLanes: async () => false } });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).code === 'persist_failed', 'failed durable release must report fixed result');
      assert(engine.snapshot().queue.jobs.length === 0, 'failed durable release must not leave a ghost lane');
    },
  },
];

tests.push(
  {
    name: 'handoff bridge: engine: lane persistence omits all epoch prompt and handoff material',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory }); const lane = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A, handoff: handoff({ prompt: 'must not persist' }) });
        await store.saveLanes([lane]); const raw = fs.readFileSync(store.lanesPath, 'utf8');
        assert(!/HANDOFF|prompt|session|epoch|retired|must not persist/i.test(raw), 'durable lanes must omit secrets and content');
        const restored = store.loadLanes(); assert(restored.length === 1 && restored[0].phase === 'held' && restored[0].reason === 'restart', 'restart must rehydrate held lane');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: lane store retains existing held and needs-user reasons after restart',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory }); const one = createApplicationLane({ ord: 1, jobId: JOB_A, canvasFilePath: PATH_A }); const two = createApplicationLane({ ord: 2, jobId: JOB_B, canvasFilePath: PATH_B }); holdLane(one, 'user_hold'); holdLane(two, 'job_broken');
        await store.saveLanes([one, two]); const loaded = store.loadLanes(); assert(loaded[0].reason === 'user_hold' && loaded[1].reason === 'job_broken', 'existing hold reasons must survive restart');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: lane store ignores unknown versions and preserves tool surface fingerprint',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const store = createLaneStore({ userDataPath: directory }); fs.mkdirSync(path.dirname(store.lanesPath), { recursive: true }); fs.writeFileSync(store.lanesPath, '{"v":99,"lanes":[]}'); assert(store.loadLanes().length === 0, 'unknown lanes version must load empty');
        const meta = { linkId: LINK, toolsSurfaceFp: 'a'.repeat(64), toolsListedAt: 1 }; assert(await store.saveLinkMeta(meta) && await store.saveLinkMeta(meta), 'unchanged tool surface should avoid write amplification'); assert(store.readLinkMeta().toolsSurfaceFp === meta.toolsSurfaceFp, 'surface fingerprint must survive restart');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: autoStart does not mint or serve a chat',
    run: async () => {
      const fake = source(); const engine = createHandoffEngine({ source: fake.api, autoStart: true });
      assert((await engine.get({ session: 'old-session', linkId: LINK })).status === 'session_ended', 'autoStart is never implicit serving'); assert(fake.calls.read === 0 && engine.snapshot().autoStart, 'autoStart must have no adapter side effect');
    },
  },
  {
    name: 'handoff bridge: engine: audit ledgers separate safe security and serving events',
    run: async () => {
      const directory = cleanDirectory();
      try {
        const audit = createAuditSink({ userDataPath: directory }); await audit.append('pause', { cause: 'idle' }, 1); await audit.append('served', { tool: 'get_handoff', outcome: 'ok', stage: 'resume' }, 2);
        const security = fs.readFileSync(audit.securityPath, 'utf8'); const serve = fs.readFileSync(audit.servePath, 'utf8'); assert(security.includes('pause') && !security.includes('HANDOFF') && serve.includes('served'), 'ledger routing must be enumerated and private');
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: engine: close fences delayed application read status and submit results',
    run: async () => {
      // Read: a completion after Close cannot adopt a handoff, persist, or
      // notify a renderer.
      const readPending = deferred(); let readCalls = 0; let readSaves = 0; let readNotices = 0;
      const readState = await started({
        sourceOverrides: { read: async () => { readCalls++; return readPending.promise; } },
        engineOptions: { store: { saveLanes: async () => { readSaves++; return true; } }, onJobChanged: () => { readNotices++; } },
      });
      const readBaseline = readSaves;
      const delayedRead = readState.engine.get({ session: readState.session, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(readCalls === 1, 'fixture must dispatch one read before Close');
      await readState.engine.close(); readPending.resolve({ kind: 'open', handoff: handoff() });
      await delayedRead; await Promise.resolve();
      assert(readState.engine.snapshot().queue.jobs[0].phase === 'unread' && readSaves === readBaseline && readNotices === 0 && readState.engine.snapshot().counts.getServed === 0,
        'a stale read must not mutate a lane, persist, notify, or serve');

      // Status: the same fence applies after an already-hosted lane polls.
      const statusPending = deferred(); let statusSaves = 0; let statusNotices = 0; let statusCalls = 0;
      const clock = createFakeClock(); const statusSource = source({
        read: async () => ({ kind: 'host' }),
        status: async () => { statusCalls++; return statusPending.promise; },
      });
      const statusEngine = createHandoffEngine({ source: statusSource.api, now: clock.now, timers: clock, holdMs: 0,
        store: { saveLanes: async () => { statusSaves++; return true; } }, onJobChanged: () => { statusNotices++; } });
      await statusEngine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); const statusChat = await statusEngine.newChat({ linkId: LINK });
      await statusEngine.get({ session: statusChat.sessionCode, linkId: LINK });
      const statusBaseline = statusSaves; clock.advance(CONSTANTS.HOST_POLL_MS);
      const delayedStatus = statusEngine.get({ session: statusChat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(statusCalls === 1, 'fixture must dispatch one status poll before Close');
      await statusEngine.close(); statusPending.resolve({ kind: 'done' });
      await delayedStatus; await Promise.resolve();
      assert(statusEngine.snapshot().queue.jobs[0].phase === 'host' && statusSaves === statusBaseline && statusNotices === 0,
        'a stale status result must not complete or persist a host lane');

      // Submit: result framing and its verdict cache are also fenced.
      const submitPending = deferred(); let submitSaves = 0; let submitNotices = 0;
      const submitState = await served({
        sourceOverrides: { submit: async () => submitPending.promise },
        engineOptions: { store: { saveLanes: async () => { submitSaves++; return true; } }, onJobChanged: () => { submitNotices++; } },
      });
      const submitBaseline = submitSaves;
      const delayedSubmit = submitState.engine.submit({ session: submitState.session, linkId: LINK, handoffCode: submitState.result.handoffCode, response: answer({ code: submitState.result.handoffCode, stage: submitState.result.stage }) });
      await new Promise(resolve => setImmediate(resolve));
      await submitState.engine.close(); submitPending.resolve({ kind: 'accepted', completed: true });
      await delayedSubmit; await Promise.resolve();
      assert(submitState.engine.snapshot().counts.submitAccepted === 0 && submitSaves === submitBaseline && submitNotices === 0,
        'a stale submit result must not cache a verdict, persist, or notify');
    },
  },
  {
    name: 'handoff bridge: engine: close before a queued push acquire never invokes the source',
    run: async () => {
      let pushSubmits = 0;
      const push = {
        async get() { return { status: 'served', handoffCode: 'PUSH-A', task: 'job-scoring', prompt: 'Synthetic scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { pushSubmits++; return { status: 'accepted' }; },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const chat = await engine.newChat({ linkId: LINK }); const servedPush = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(servedPush.status === 'served' && servedPush.kind === 'push', 'fixture must receive a scoring handoff');
      const pending = engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: servedPush.handoffCode, response: 'Synthetic scoring answer.' });
      await engine.close(); await pending; await Promise.resolve();
      assert(pushSubmits === 0 && engine.snapshot().counts.submitAccepted === 0, 'Close during semaphore acquisition must stop the queued push source call and result framing');
    },
  },
  {
    name: 'handoff bridge: engine: an aborted held GET releases its waiter without changing submit behavior',
    run: async () => {
      const clock = createFakeClock(); let polls = 0;
      const push = {
        async get() { polls++; return { status: 'waiting', remaining: { ready: 0, working: 1, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, now: clock.now, timers: clock, holdMs: 30_000 });
      const chat = await engine.newChat({ linkId: LINK }); const abort = new AbortController();
      const pending = engine.get({ session: chat.sessionCode, linkId: LINK, signal: abort.signal });
      await new Promise(resolve => setImmediate(resolve));
      assert(engine.debugState().waiters === 1 && polls === 1, 'held GET must retain exactly one wake waiter');
      abort.abort(); const result = await pending;
      assert(result.status === 'retry' && engine.debugState().waiters === 0 && clock.pendingCount() === 0 && polls === 1,
        'aborted GET must return promptly, remove timer/listener state, and launch no follow-up source poll');
    },
  },
  {
    name: 'handoff bridge: engine: scope changes fence each source family independently',
    run: async () => {
      const app = source(); let pushGets = 0; let pushSubmits = 0;
      const push = {
        async get() { pushGets++; return { status: 'served', handoffCode: 'PUSH-SCOPE', task: 'job-scoring', prompt: 'Synthetic scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { pushSubmits++; return { status: 'unknown_handoff' }; },
      };
      const engine = createHandoffEngine({ sources: { application: app.api, push }, scope: { applications: true, scoring: true }, holdMs: 0 });
      assert((await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] })).ok, 'fixture must release an application lane before lowering scope');
      const chat = await engine.newChat({ linkId: LINK });
      engine.setScope({ applications: false, scoring: true });
      const pushed = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(pushed.kind === 'push' && app.calls.read === 0 && pushGets === 1, 'applications-off must leave released lanes inert while scoring remains live');
      const frozenPushGets = pushGets;
      engine.setScope({ applications: true, scoring: false });
      const applied = await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(applied.kind === 'application' && app.calls.read === 1 && pushGets === frozenPushGets, 'scoring-off must stop scoring polls while application serving resumes');
      engine.setScope({ applications: false, scoring: false });
      const denied = await engine.submit({ session: chat.sessionCode, linkId: LINK, handoffCode: applied.handoffCode, response: answer({ code: applied.handoffCode, stage: applied.stage }) });
      assert(denied.status === 'held' && denied.reason === 'scope_disabled' && app.calls.submit === 0 && pushSubmits === 0,
        'a later scope downgrade must block outstanding application answers without either adapter call');
    },
  },
  {
    name: 'handoff bridge: engine: terminal evidence is pruned after one hour and persisted once',
    run: async () => {
      const clock = createFakeClock(); let saves = 0;
      const engine = createHandoffEngine({ source: source({ read: async () => ({ kind: 'done' }) }).api, now: clock.now, timers: clock, holdMs: 0,
        store: { saveLanes: async () => { saves++; return true; } } });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); const chat = await engine.newChat({ linkId: LINK });
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(engine.snapshot().queue.jobs[0].phase === 'done', 'fixture must retain terminal evidence before pruning');
      const before = saves; clock.advance(60 * 60_000); await engine.tick(clock.now());
      assert(engine.snapshot().queue.jobs.length === 0 && saves === before + 1, 'one-hour terminal evidence prune must bound memory and durable lanes');
    },
  },
  {
    name: 'handoff bridge: engine: a queued hint cannot revive terminal evidence or block its prune',
    run: async () => {
      const clock = createFakeClock();
      const engine = createHandoffEngine({ source: source({ read: async () => ({ kind: 'done' }) }).api, now: clock.now, timers: clock, holdMs: 0 });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] }); const chat = await engine.newChat({ linkId: LINK });
      assert(engine.hint({ jobId: JOB_A }) && engine.hint({ jobId: JOB_A }) && clock.pendingCount() === 1, 'second hint must queue one deferred invalidation');
      await engine.get({ session: chat.sessionCode, linkId: LINK });
      assert(engine.snapshot().queue.jobs[0].phase === 'done' && clock.pendingCount() === 0, 'terminal transition must clear the queued hint timer');
      clock.advance(CONSTANTS.HINT_MIN_INTERVAL_MS); clock.advance(60 * 60_000); await engine.tick(clock.now());
      assert(engine.snapshot().queue.jobs.length === 0, 'a stale hint callback must not set needsRefresh and prevent terminal pruning');
    },
  },
  {
    name: 'handoff bridge: engine: Close rolls back a delayed push-hub selection',
    run: async () => {
      const selection = deferred(); const selected = new Set(); const key = 'a'.repeat(64);
      const push = {
        async get() { return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
        async selectHubKey(value) { await selection.promise; selected.add(value); return true; },
        async unselectHubKey(value) { selected.delete(value); return true; },
        clearHubs() { selected.clear(); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true } });
      const selecting = engine.selectPushHubKey(key); await Promise.resolve();
      await engine.close(); selection.resolve();
      assert(await selecting === false && selected.size === 0,
        'a source selection completing after Close must be removed rather than repopulating closed push state');
    },
  },
  {
    name: 'handoff bridge: engine: delayed old hub refresh cannot populate a replacement engine discovery cache',
    run: async () => {
      const refreshGate = deferred(); const key = 'b'.repeat(64); const discovered = []; let refreshes = 0;
      const push = {
        async get() { return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
        async submit() { return { status: 'unknown_handoff' }; },
        async refreshHubs() {
          refreshes += 1;
          if (refreshes === 1) await refreshGate.promise;
          discovered.splice(0, discovered.length, { key, pending: 1, tasks: [{ task: 'job-scoring', pending: 1 }], excluded: {} });
          return true;
        },
        clearHubs() {},
        status() { return { discovered, selectedHubs: [], served: 0, held: 0, working: 0, needsYou: 0 }; },
      };
      const oldEngine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true } });
      const staleRefresh = oldEngine.refreshPushHubs(); await Promise.resolve();
      await oldEngine.close();
      const replacement = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true } });
      refreshGate.resolve();
      assert(await staleRefresh === false && replacement.snapshot().push.discovered.length === 0,
        'a stale shared-source refresh must stay hidden until the replacement performs its own refresh');
      assert(await replacement.refreshPushHubs() === true && replacement.snapshot().push.discovered.length === 1,
        'the replacement may expose only discovery it refreshed under its own generation');
    },
  },
  {
    name: 'handoff bridge: engine: rotation discards a delayed old-chat application get before it can seed the replacement',
    run: async () => {
      const oldRead = deferred(); let reads = 0; let saves = 0;
      const application = source({
        read: async () => {
          reads++;
          return reads === 1
            ? oldRead.promise
            : { kind: 'open', handoff: handoff({ code: 'HANDOFF-ADA-EXAMPLE', prompt: 'Synthetic Ada replacement prompt.' }) };
        },
      });
      const engine = createHandoffEngine({ source: application.api, holdMs: 0, store: { saveLanes: async () => { saves++; return true; } } });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const oldChat = await engine.newChat({ linkId: LINK });
      const oldGet = engine.get({ session: oldChat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(reads === 1, 'old chat must dispatch exactly one delayed application read');

      const replacement = await engine.newChat({ linkId: LINK });
      const baseline = engine.snapshot(); const baselineSaves = saves;
      assert(baseline.chat.calls === 0 && baseline.chat.bytesServed === 0 && baseline.chat.bytesReceived === 0
        && baseline.queue.jobs[0]?.phase === 'unread', 'rotation must start an untouched replacement epoch and clear the old read lane state');
      oldRead.resolve({ kind: 'open', handoff: handoff({ code: 'HANDOFF-MARISOL-OLD', prompt: 'Synthetic Marisol old-chat prompt.' }) });
      assert((await oldGet).status === 'retry', 'the old application GET must never serve after its epoch rotates');
      const afterOld = engine.snapshot();
      assert(afterOld.chat.calls === 0 && afterOld.chat.bytesServed === 0 && afterOld.chat.bytesReceived === 0
        && afterOld.counts.getServed === 0 && afterOld.queue.jobs[0]?.phase === 'unread' && saves === baselineSaves,
      'the late application read must not alter replacement calls, bytes, lane state, counters, or persistence');

      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(fresh.status === 'served' && fresh.handoffCode === 'HANDOFF-ADA-EXAMPLE' && reads === 2,
        'the replacement chat must re-read and serve its own synthetic Ada handoff rather than an old cache');
    },
  },
  {
    name: 'handoff bridge: engine: rotation fences delayed old-chat push get with its original epoch id',
    run: async () => {
      const oldPushGet = deferred(); const getEpochs = []; const closedEpochs = [];
      const push = {
        async get({ epoch }) {
          getEpochs.push(epoch);
          return getEpochs.length === 1
            ? oldPushGet.promise
            : { status: 'served', handoffCode: 'PUSH-ADA-EXAMPLE', task: 'job-scoring', prompt: 'Synthetic Ada replacement scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit() { return { status: 'unknown_handoff' }; },
        closeEpoch(epoch) { closedEpochs.push(epoch); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const oldChat = await engine.newChat({ linkId: LINK });
      const oldGet = engine.get({ session: oldChat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      assert(JSON.stringify(getEpochs) === JSON.stringify(['epoch-1']), 'the old push GET must receive only epoch-1');

      const replacement = await engine.newChat({ linkId: LINK });
      oldPushGet.resolve({ status: 'served', handoffCode: 'PUSH-MARISOL-OLD', task: 'job-scoring', prompt: 'Synthetic Marisol old scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } });
      assert((await oldGet).status === 'retry', 'the late old push GET must never frame a served handoff');
      const afterOld = engine.snapshot();
      assert(afterOld.chat.calls === 0 && afterOld.chat.bytesServed === 0 && afterOld.chat.bytesReceived === 0 && afterOld.counts.getServed === 0
        && closedEpochs.every(epoch => epoch === 'epoch-1'), 'a late push GET may clean up only its original epoch and cannot mutate replacement accounting');

      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(fresh.status === 'served' && fresh.handoffCode === 'PUSH-ADA-EXAMPLE'
        && JSON.stringify(getEpochs) === JSON.stringify(['epoch-1', 'epoch-2']), 'the replacement push GET must use epoch-2 and still work');
    },
  },
  {
    name: 'handoff bridge: engine: rotation discards a delayed old-chat application submit without retaining its verdict',
    run: async () => {
      const oldSubmit = deferred(); let submits = 0; let saves = 0;
      const application = source({
        read: async () => ({ kind: 'open', handoff: handoff({ code: 'HANDOFF-EXAMPLE', prompt: 'Synthetic example application prompt.' }) }),
        submit: async () => {
          submits++;
          return submits === 1 ? oldSubmit.promise : { kind: 'accepted', completed: true };
        },
      });
      const engine = createHandoffEngine({ source: application.api, holdMs: 0, store: { saveLanes: async () => { saves++; return true; } } });
      await engine.release({ jobs: [{ jobId: JOB_A, canvasFilePath: PATH_A }] });
      const oldChat = await engine.newChat({ linkId: LINK });
      const servedOld = await engine.get({ session: oldChat.sessionCode, linkId: LINK });
      const stale = engine.submit({ session: oldChat.sessionCode, linkId: LINK, handoffCode: servedOld.handoffCode, response: answer({ code: servedOld.handoffCode, stage: servedOld.stage }) });
      await new Promise(resolve => setImmediate(resolve));
      assert(submits === 1, 'old chat must dispatch its one delayed application submit');

      const replacement = await engine.newChat({ linkId: LINK }); const baselineSaves = saves;
      oldSubmit.resolve({ kind: 'accepted', completed: true });
      assert((await stale).status === 'retry', 'an accepted old application submit must be reported only as retry after rotation');
      const afterOld = engine.snapshot();
      assert(afterOld.chat.calls === 0 && afterOld.chat.bytesServed === 0 && afterOld.chat.bytesReceived === 0
        && afterOld.counts.submitAccepted === 0 && afterOld.queue.jobs[0]?.phase === 'awaiting' && saves === baselineSaves,
      'the late application submit must not complete the lane, persist, or seed replacement verdict state');

      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      const accepted = await engine.submit({ session: replacement.sessionCode, linkId: LINK, handoffCode: fresh.handoffCode, response: answer({ code: fresh.handoffCode, stage: fresh.stage }) });
      assert(fresh.status === 'served' && accepted.status === 'accepted' && submits === 2,
        'the replacement must re-serve and submit the same example bytes through a new source call, not an old verdict cache');
    },
  },
  {
    name: 'handoff bridge: engine: rotation discards a delayed old-chat push submit and keeps push verdicts epoch-local',
    run: async () => {
      const oldPushSubmit = deferred(); const getEpochs = []; const submitEpochs = []; const closedEpochs = [];
      const push = {
        async get({ epoch }) {
          getEpochs.push(epoch);
          return { status: 'served', handoffCode: 'PUSH-EXAMPLE', task: 'job-scoring', prompt: 'Synthetic example scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit({ epoch }) {
          submitEpochs.push(epoch);
          return submitEpochs.length === 1 ? oldPushSubmit.promise : { status: 'accepted' };
        },
        closeEpoch(epoch) { closedEpochs.push(epoch); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const oldChat = await engine.newChat({ linkId: LINK });
      const servedOld = await engine.get({ session: oldChat.sessionCode, linkId: LINK });
      const stale = engine.submit({ session: oldChat.sessionCode, linkId: LINK, handoffCode: servedOld.handoffCode, response: 'Synthetic example scoring answer.' });
      await new Promise(resolve => setImmediate(resolve));
      assert(JSON.stringify(getEpochs) === JSON.stringify(['epoch-1']) && JSON.stringify(submitEpochs) === JSON.stringify(['epoch-1']),
        'old push get and submit must be tagged with the original epoch id');

      const replacement = await engine.newChat({ linkId: LINK });
      oldPushSubmit.resolve({ status: 'accepted' });
      assert((await stale).status === 'retry', 'an accepted old push submit must never become an accepted replacement result');
      const afterOld = engine.snapshot();
      assert(afterOld.chat.calls === 0 && afterOld.chat.bytesServed === 0 && afterOld.chat.bytesReceived === 0 && afterOld.counts.submitAccepted === 0
        && closedEpochs.every(epoch => epoch === 'epoch-1'), 'the old push verdict must not charge, cache, or close a replacement epoch');

      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      const accepted = await engine.submit({ session: replacement.sessionCode, linkId: LINK, handoffCode: fresh.handoffCode, response: 'Synthetic example scoring answer.' });
      assert(fresh.status === 'served' && accepted.status === 'accepted'
        && JSON.stringify(getEpochs) === JSON.stringify(['epoch-1', 'epoch-2']) && JSON.stringify(submitEpochs) === JSON.stringify(['epoch-1', 'epoch-2']),
      'the replacement must independently serve and accept through epoch-2 rather than replaying the old push verdict');
    },
  },
  {
    name: 'handoff bridge: engine: concurrent drain retires to null and fences a delayed old push call before replacement',
    run: async () => {
      const delayedOld = deferred(); const getEpochs = []; const closedEpochs = [];
      const push = {
        async get({ epoch }) {
          getEpochs.push(epoch);
          if (getEpochs.length === 1) return delayedOld.promise;
          if (getEpochs.length === 2) return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } };
          return { status: 'served', handoffCode: 'PUSH-ADA-AFTER-DRAIN', task: 'job-scoring', prompt: 'Synthetic Ada post-drain scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } };
        },
        async submit() { return { status: 'unknown_handoff' }; },
        closeEpoch(epoch) { closedEpochs.push(epoch); },
      };
      const engine = createHandoffEngine({ sources: { application: source().api, push }, scope: { applications: false, scoring: true }, holdMs: 0 });
      const oldChat = await engine.newChat({ linkId: LINK });
      const stale = engine.get({ session: oldChat.sessionCode, linkId: LINK });
      await new Promise(resolve => setImmediate(resolve));
      const draining = await engine.get({ session: oldChat.sessionCode, linkId: LINK });
      assert(draining.status === 'queue_empty' && JSON.stringify(getEpochs) === JSON.stringify(['epoch-1', 'epoch-1'])
        && engine.snapshot().chat.ordinal === 0, 'a concurrent empty GET must retire the old epoch to null while both old calls used epoch-1');

      delayedOld.resolve({ status: 'served', handoffCode: 'PUSH-MARISOL-LATE', task: 'job-scoring', prompt: 'Synthetic Marisol late scoring prompt.', remaining: { ready: 0, working: 0, needsYou: 0 } });
      assert((await stale).status === 'retry', 'a delayed call that resumes after drain-to-null must never serve');
      const nullEpoch = engine.snapshot();
      assert(nullEpoch.chat.ordinal === 0 && nullEpoch.chat.calls === 0 && nullEpoch.chat.bytesServed === 0 && nullEpoch.counts.getServed === 0
        && closedEpochs.every(epoch => epoch === 'epoch-1'), 'the delayed old call must not resurrect or mutate the null epoch');

      const replacement = await engine.newChat({ linkId: LINK });
      const fresh = await engine.get({ session: replacement.sessionCode, linkId: LINK });
      assert(fresh.status === 'served' && fresh.handoffCode === 'PUSH-ADA-AFTER-DRAIN'
        && JSON.stringify(getEpochs) === JSON.stringify(['epoch-1', 'epoch-1', 'epoch-2']), 'a fresh chat after drain must work with a new epoch id');
    },
  },
);

export default tests;
