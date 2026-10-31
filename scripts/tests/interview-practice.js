import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';
import { withTimeout } from './fixtures/handoff-bridge/harness.js';
import { PRACTICE_CODE_RE, PRACTICE_FINISH_TOOL, buildPracticeInterviewPrompt, newPracticeCode, orderPracticeQuestions, practiceCodeHash, validatePracticeFeedback } from '../../electron/ipc/interviewQaPractice.js';
import { addInterviewQaCard, findInterviewPracticeSession, listInterviewPracticeSessions, loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPractice, saveInterviewPracticeSession } from '../../electron/ipc/interviewQaStore.js';
import { createInterviewPracticeRegistry } from '../../electron/ipc/interviewPracticeRegistry.js';
import { PRACTICE_MCP_PATH, createPracticeMcpHandler, createPracticeRequestHandler, isPracticeRequest } from '../../electron/ipc/handoffBridge/practiceMcp.js';
import { CLAUDE_NEW_CHAT_URL, createPracticeChatLauncher } from '../../electron/ipc/interviewPracticeLauncher.js';
import { practiceBridgeReadiness, registerInterviewPreparationHandlers } from '../../electron/ipc/interviewPreparation.js';

async function userData(run) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-'));
  try { await run(dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}
const cards = [
  { id: 'intro', scope: 'foundation', question: 'Tell me about yourself.', headline: { text: 'Product engineer, five years.' }, bullets: [{ text: 'Shipped the checkout redesign' }], example: { text: 'At Acme I led the migration.' }, extensions: [] },
  { id: 'why', scope: 'company', question: 'Why Discord?', headline: '', bullets: [], example: '', extensions: [] },
];
const feedbackPayload = code => ({
  session: code, overall: { score: 7, summary: 'Solid call; the opening was stiff.' },
  planned: [{ question: 'Tell me about yourself.', asked: true, askedAs: 'Walk me through your path so far.', score: 8, covered: 'Hit the headline and the example.', adapted: 'Adjusted fine.', improve: 'Tighten the ending.', extension: 'Mention the on-call rotation you ran.' }, { question: 'Why Discord?', asked: false, score: 1 }],
  moments: [{ kind: 'curveball', prompt: 'If voice went down tomorrow, what would you ship?', score: 5, note: 'Froze for a bit.' }],
  communication: { pace: 'Good', filler: 'Many "like"s' }, priorities: ['Curveballs', 'Shorter intro'],
  transcript: [{ role: 'interviewer', text: 'Hi, can you hear me?' }, { role: 'candidate', text: 'Loud and clear.' }],
});
function fakeRequest({ url = PRACTICE_MCP_PATH, method = 'POST', host = 'bridge.example.com', body = '', headers = {} } = {}) {
  const req = new EventEmitter();
  Object.assign(req, { url, method, headers: { host, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers }, socket: { remoteAddress: '203.0.113.9' }, destroy() {} });
  const res = { status: 0, headers: null, body: '', headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(data) { this.body = String(data || ''); } };
  setTimeout(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end'); }, 0);
  return { req, res };
}
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

export default [
  { name: 'practice prompt: a one-shot code, the whole plan with prepared answers, company context and the connector hand-back', async run() {
    const code = newPracticeCode();
    assert.match(code, PRACTICE_CODE_RE);
    assert.notEqual(newPracticeCode(), code);
    const prompt = buildPracticeInterviewPrompt({ code, company: 'Discord', role: 'Product Engineer', roleSummary: 'Own features end to end.', roleThemes: ['voice', 'reliability'], companyFacts: [{ fact: 'Discord runs on Elixir and Rust.', sourceUrl: 'https://x', evidenceQuote: 'q' }], recentContext: ['Launched Clyde.'], cards });
    for (const needle of ['interviewer from Discord', code, PRACTICE_FINISH_TOOL, 'reword', 'never read one out verbatim', 'small talk', 'here at Discord we', 'ENTIRE call', 'Discord runs on Elixir and Rust.', 'Launched Clyde.', 'voice; reliability',
      '1. [foundation] Tell me about yourself.', 'Product engineer, five years.', 'Key points: Shipped the checkout redesign', 'Example: At Acme I led the migration.', '2. [company] Why Discord?', 'No prepared answer yet']) {
      assert.ok(prompt.includes(needle), `prompt carries ${JSON.stringify(needle)}`);
    }
    assert.match(prompt, /No template/u, 'the interviewer is free to shape the call');
    assert.match(prompt, /pool, not a checklist/u, 'a long plan is sampled to one realistic call');
    assert.match(prompt, /Never mention the tool, the feedback, the app/u, 'the sign-off stays in character');
    assert.match(prompt, /optional extension material/u, 'feedback separates memorized coverage from optional extension material');
    assert.doesNotMatch(prompt, /must ask a curveball/iu);
    assert.throws(() => buildPracticeInterviewPrompt({ code: 'nope', company: 'x', cards }), /session code/u);
  } },
  { name: 'practice feedback: bounded, typed, and rejected with a reason the chat can fix', async run() {
    const ok = validatePracticeFeedback(feedbackPayload('PRACTICE-X'));
    assert.equal(ok.overall.score, 7); assert.equal(ok.planned.length, 2); assert.equal(ok.planned[1].askedAs, ''); assert.equal(ok.moments[0].kind, 'curveball');
    assert.equal(ok.planned[0].extension, 'Mention the on-call rotation you ran.'); assert.equal(ok.planned[1].extension, '');
    assert.equal(ok.planned[1].score, null, 'a placeholder score on an unasked question is dropped');
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), planned: [{ question: 'q', asked: true, extension: 'x'.repeat(601) }] }), /planned\[0\]\.extension/u);
    assert.deepEqual(ok.communication, { pace: 'Good', clarity: '', structure: '', confidence: '', filler: 'Many "like"s' });
    assert.equal(ok.transcript.length, 2);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), overall: { score: 11, summary: 's' } }), /overall\.score/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), moments: [{ kind: 'rant', prompt: 'x' }] }), /moments\[0\]\.kind/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), priorities: ['a', 'b', 'c', 'd', 'e', 'f'] }), /priorities/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), overall: { score: 5, summary: 'bad\u0007char' } }), /overall\.summary/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), planned: [{ asked: true }] }), /planned\[0\]/u);
    assert.throws(() => validatePracticeFeedback({ ...feedbackPayload('c'), transcript: [{ role: 'user', text: 'x' }] }), /transcript\[0\]\.role/u);
  } },
  { name: 'practice store: planned order, armed session found by code hash, feedback with history', async run() {
    await userData(async dir => {
      await saveInterviewPractice({ userDataPath: dir, nodeId: 'h', practice: { order: ['Tell me about yourself.', 'Why Discord?', 'bad\u0001'] } });
      let saved = await loadInterviewPractice({ userDataPath: dir, nodeId: 'h' });
      assert.deepEqual(saved.order, ['Tell me about yourself.', 'Why Discord?']); assert.equal(saved.session, null);
      assert.equal(await loadInterviewPractice({ userDataPath: dir, nodeId: 'nobody' }), null);
      const hash = practiceCodeHash('PRACTICE-A');
      await saveInterviewPracticeSession({ userDataPath: dir, nodeId: 'h', session: { codeHash: hash, status: 'armed', armedAt: new Date().toISOString(), company: 'Discord' } });
      const found = await findInterviewPracticeSession({ userDataPath: dir, codeHash: hash });
      assert.equal(found.nodeId, 'h'); assert.equal(found.session.status, 'armed');
      assert.equal(await findInterviewPracticeSession({ userDataPath: dir, codeHash: practiceCodeHash('PRACTICE-B') }), null);
      await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: validatePracticeFeedback(feedbackPayload('x')), receivedAt: '2026-10-30T01:00:00.000Z' });
      await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: { ...validatePracticeFeedback(feedbackPayload('x')), overall: { score: 9, summary: 'Better.' } }, receivedAt: '2026-10-30T02:00:00.000Z' });
      saved = await loadInterviewPractice({ userDataPath: dir, nodeId: 'h' });
      assert.equal(saved.feedback.overall.score, 9); assert.equal(saved.history.length, 1); assert.equal(saved.history[0].overall.score, 7);
      assert.equal(saved.session.status, 'finished'); assert.deepEqual(saved.order, ['Tell me about yourself.', 'Why Discord?'], 'the plan survives feedback');
      assert.equal(saved.feedback.session.company, 'Discord');
      assert.equal(await recordInterviewPracticeFeedback({ userDataPath: dir, nodeId: 'h', feedback: validatePracticeFeedback(feedbackPayload('x')), codeHash: hash }), null, 'a finished session refuses a second write for its code');
      assert.equal((await listInterviewPracticeSessions({ userDataPath: dir })).length, 1);
    });
  } },
  { name: 'practice registry: arm once, accept feedback once, refuse unknown, duplicate and expired codes', async run() {
    await userData(async dir => {
      let clock = Date.parse('2026-10-30T10:00:00Z');
      let scans = 0;
      const counted = { listInterviewPracticeSessions: async args => { scans += 1; return listInterviewPracticeSessions(args); }, loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPracticeSession, updateInterviewPracticeSession: (await import('../../electron/ipc/interviewQaStore.js')).updateInterviewPracticeSession };
      const registry = createInterviewPracticeRegistry({ userDataPath: dir, now: () => clock, store: counted });
      const events = []; registry.subscribe(event => events.push(event));
      const code = await registry.arm({ nodeId: 'h', company: 'Discord', role: 'PE', questionCount: 2 });
      assert.match(code, PRACTICE_CODE_RE);
      assert.equal((await registry.check(code)).status, 'armed');
      assert.equal((await registry.check('PRACTICE-ZZZZZZZZZZZZZZZZZZZZ')).status, 'unknown');
      for (let index = 0; index < 20; index += 1) await registry.check(`PRACTICE-${'Q'.repeat(19)}${'ABCDEFGHJKLMNPQRSTUV'[index]}`);
      assert.equal(scans, 1, 'unknown codes never make the store rescan the disk');
      await assert.rejects(registry.arm({ nodeId: 'h' }), /already in progress/u);
      assert.equal((await registry.status('h')).session.status, 'armed');
      assert.equal((await registry.status('h')).session.codeHash, undefined, 'the renderer view never carries the code hash');
      const rejected = await registry.finish(code, { overall: {} });
      assert.equal(rejected.status, 'rejected'); assert.match(rejected.note, /overall/u);
      assert.equal((await registry.finish('PRACTICE-ZZZZZZZZZZZZZZZZZZZZ', { overall: {} })).status, 'unknown_session', 'an unknown code is reported before the payload is judged');
      const race = await Promise.all([registry.finish(code, feedbackPayload(code)), registry.finish(code, feedbackPayload(code))]);
      assert.deepEqual(race.map(item => item.status).sort(), ['accepted', 'duplicate'], 'two racing finishes store exactly once');
      assert.match(race.find(item => item.status === 'accepted').note, /Stay in character/u, 'the accepted note keeps the interviewer in character');
      assert.equal((await registry.finish(code, feedbackPayload(code))).status, 'duplicate');
      assert.deepEqual(events.map(event => event.kind), ['armed', 'feedback']);
      assert.equal((await registry.status('h')).history.length, 0);
      const view = await registry.status('h');
      assert.equal(view.session.status, 'finished'); assert.equal(view.feedback.overall.score, 7);
      // A second registry (app restart) still resolves a persisted session from disk.
      const other = createInterviewPracticeRegistry({ userDataPath: dir, now: () => clock });
      const code2 = await registry.arm({ nodeId: 'h', company: 'Discord' });
      assert.equal((await other.check(code2)).status, 'armed');
      clock += 4 * 60 * 60_000;
      assert.equal((await other.check(code2)).status, 'expired');
      assert.equal((await other.finish(code2, feedbackPayload(code2))).status, 'expired');
      const code3 = await registry.arm({ nodeId: 'h' });
      await registry.cancel('h');
      assert.equal((await registry.finish(code3, feedbackPayload(code3))).status, 'cancelled');
    });
  } },
  { name: 'practice connector: MCP initialize, tools and finish call reach the registry; notifications are 202', async run() {
    const calls = [];
    const mcp = createPracticeMcpHandler({ finish: async (code, payload) => { calls.push(['finish', code, payload.overall.score]); return { status: 'accepted' }; }, check: async code => { calls.push(['check', code]); return { status: 'armed' }; } });
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.status, 200); assert.equal(init.body.result.protocolVersion, '2025-06-18'); assert.ok(init.body.result.capabilities.tools);
    assert.equal((await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1900-01-01' } })).body.result.protocolVersion, '2025-06-18');
    assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.deepEqual(list.body.result.tools.map(tool => tool.name), ['check_practice_interview', PRACTICE_FINISH_TOOL]);
    assert.equal(list.body.result.tools[1].inputSchema.required.includes('session'), true);
    const done = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: PRACTICE_FINISH_TOOL, arguments: feedbackPayload('PRACTICE-A') } });
    assert.equal(done.body.result.structuredContent.status, 'accepted'); assert.equal(done.body.result.isError, false);
    await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_practice_interview', arguments: { session: ' PRACTICE-A ' } } });
    assert.deepEqual(calls, [['finish', 'PRACTICE-A', 7], ['check', 'PRACTICE-A']]);
    assert.equal((await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: PRACTICE_FINISH_TOOL, arguments: { overall: {} } } })).body.result.structuredContent.status, 'rejected');
    assert.equal((await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: { session: 'x' } } })).body.error.code, -32602);
    assert.equal((await mcp({ jsonrpc: '2.0', id: 8, method: 'resources/list' })).body.error.code, -32601);
    assert.equal((await mcp({ id: 9, method: 'ping' })).status, 400);
  } },
  { name: 'practice connector HTTP: only /practice/mcp POST JSON on the public host, bounded and rate limited', async run() {
    let clock = 0;
    const handler = createPracticeRequestHandler({ hostname: 'bridge.example.com', now: () => clock, limits: { perSourceCapacity: 3, perSourcePerSecond: 1, maxBodyBytes: 200 }, mcp: async body => ({ status: 200, body: { jsonrpc: '2.0', id: body.id, result: { ok: true } } }) });
    assert.equal(isPracticeRequest({ url: '/practice/mcp?x=1' }), true); assert.equal(isPracticeRequest({ url: '/mcp' }), false);
    let pair = fakeRequest({ url: '/mcp' }); assert.equal(await handler(pair.req, pair.res), false, 'the OAuth bridge keeps every other route');
    pair = fakeRequest({ method: 'GET' }); assert.equal(await handler(pair.req, pair.res), true); assert.equal(pair.res.status, 405);
    pair = fakeRequest({ host: 'other.example.com', body: rpc(1, 'ping') }); await handler(pair.req, pair.res); assert.equal(pair.res.status, 421);
    pair = fakeRequest({ body: rpc(1, 'ping') }); await handler(pair.req, pair.res); assert.equal(pair.res.status, 200); assert.equal(JSON.parse(pair.res.body).result.ok, true);
    pair = fakeRequest({ body: 'x'.repeat(300) }); await handler(pair.req, pair.res); assert.equal(pair.res.status, 413);
    pair = fakeRequest({ body: 'not json' }); await handler(pair.req, pair.res); assert.equal(pair.res.status, 400);
    pair = fakeRequest({ body: rpc(1, 'ping') }); await handler(pair.req, pair.res); assert.equal(pair.res.status, 429, 'the fourth call in the same second is throttled'); assert.ok(pair.res.headers['Retry-After']);
    clock += 2000;
    pair = fakeRequest({ body: rpc(1, 'ping'), headers: { 'content-type': 'text/plain' } }); await handler(pair.req, pair.res); assert.equal(pair.res.status, 415);
    clock += 60_000;
    const v6 = suffix => fakeRequest({ body: rpc(1, 'ping'), headers: { 'cf-connecting-ip': `2001:db8:1:2:${suffix}` } });
    for (const suffix of ['a::1', 'b::2', 'c::3']) { pair = v6(suffix); await handler(pair.req, pair.res); assert.equal(pair.res.status, 200); }
    pair = v6('d::4'); await handler(pair.req, pair.res); assert.equal(pair.res.status, 429, 'addresses inside one /64 share a bucket');
    clock += 60_000;
    pair = fakeRequest({ method: 'GET' }); assert.equal(handler.preflight(pair.req, pair.res), false); assert.equal(pair.res.status, 405, 'the Expect preflight refuses before any 100 Continue');
    assert.equal(handler.preflight({ url: '/mcp' }, {}), null, 'the OAuth bridge keeps its own preflight');
    pair = fakeRequest({ body: rpc(1, 'ping') }); assert.equal(handler.preflight(pair.req, pair.res), true); await handler(pair.req, pair.res); assert.equal(pair.res.status, 200, 'an admitted request is served without a second gate');
  } },
  { name: 'practice launcher: opens claude.ai in front, waits for the composer, inserts the starter and never sends', async run() {
    const scripts = [];
    const make = answers => createPracticeChatLauncher({ delay: async () => {}, now: () => scripts.length * 1000, editorTimeoutMs: 5000, run: async (script, args) => { scripts.push(args); return answers(script, args); } });
    const launcher = make((script, args) => (args.length === 1 ? '7:42' : /tab\.execute\(/u.test(script) ? (/insertText/u.test(args[2]) ? 'match' : JSON.stringify({ ready: true, path: '/new', origin: 'https://claude.ai' })) : 'focused'));
    const result = await launcher.launch({ prompt: 'Hello interviewer' });
    assert.deepEqual(result, { ok: true, tab: { windowId: '7', tabId: '42' } });
    assert.deepEqual(scripts[0], [CLAUDE_NEW_CHAT_URL]);
    assert.ok(scripts.some(args => args[2]?.includes('"Hello interviewer"')), 'the starter is inserted through page script, not a URL');
    assert.ok(!scripts.some(args => /Send|Enter|submit\(/u.test(args[2] || '')), 'nothing presses send');
    const mismatch = make((script, args) => (args.length === 1 ? '1:2' : /insertText/u.test(args[2] || '') ? 'mismatch' : JSON.stringify({ ready: true, path: '/new', origin: 'https://claude.ai' })));
    assert.equal((await mismatch.launch({ prompt: 'x' })).reason, 'insert_mismatch');
    let inserts = 0;
    const late = make((script, args) => (args.length === 1 ? '1:2' : /insertText/u.test(args[2] || '') ? (inserts += 1, inserts < 3 ? 'mismatch:' : 'match') : JSON.stringify({ ready: true, path: '/new', origin: 'https://claude.ai' })));
    assert.equal((await late.launch({ prompt: 'x' })).ok, true, 'an empty composer (editor not attached yet) is retried');
    assert.equal(inserts, 3);
    const login = make((script, args) => (args.length === 1 ? '1:2' : JSON.stringify({ ready: false, path: '/login', origin: 'https://claude.ai' })));
    assert.equal((await login.launch({ prompt: 'x' })).reason, 'login_required');
    const elsewhere = make((script, args) => (args.length === 1 ? '1:2' : JSON.stringify({ ready: true, path: '/', origin: 'https://evil.example' })));
    assert.equal((await elsewhere.launch({ prompt: 'x' })).reason, 'editor_timeout', 'another origin never counts as ready');
    assert.ok(!scripts.some(args => (args[2] || '').includes('insertText') && scripts.indexOf(args) > scripts.length - 3), 'nothing was inserted elsewhere');
    assert.match(scripts.find(args => /insertText/u.test(args[2] || ''))[2], /location\.origin !== "https:\/\/claude\.ai"/u, 'the insert script itself refuses a foreign origin');
    const off = make(() => { throw Object.assign(new Error('execution error: Google Chrome got an error: Executing JavaScript through AppleScript is turned off.'), { stderr: 'Executing JavaScript through AppleScript is turned off' }); });
    assert.equal((await off.launch({ prompt: 'x' })).reason, 'apple_events_js_off');
    assert.equal((await launcher.launch({ prompt: '' })).reason, 'empty_prompt');
  } },
  { name: 'practice IPC: start arms, launches and reports; load and cancel round-trip; the bridge and the brief binding gate it', async run() {
    await userData(async dir => {
      const handlers = new Map(); const launches = []; const notices = [];
      let launchResult = { ok: true, tab: { windowId: '1', tabId: '2' } };
      let status = { config: { hostname: 'bridge.example.com' }, enabled: true, serving: 'live' };
      const inputs = { careerSnapshotId: 'd'.repeat(64), jobUrlSha256: (await import('node:crypto')).createHash('sha256').update('https://jobs.example/1').digest('hex'), applicationArtifactId: 'a'.repeat(64), applicationArtifactDigest: 'b'.repeat(64) };
      const brief = { inputs, role: { title: 'Product Engineer', company: 'Discord', summary: 'Own features.' }, roleThemes: ['voice'], companyFacts: [{ fact: 'Discord runs on Elixir.' }], recentContext: [] };
      registerInterviewPreparationHandlers({ appInstance: { getPath: () => dir }, registerHandler: (channel, handler) => handlers.set(channel, handler),
        practiceRegistry: createInterviewPracticeRegistry({ userDataPath: dir }), practiceLauncher: { launch: async ({ prompt }) => { launches.push(prompt); return launchResult; } },
        bridgeStatus: () => status, broadcast: event => notices.push(event), loadPreparedBrief: async ({ briefRecordId }) => (briefRecordId === 'c'.repeat(64) ? brief : null) });
      const nodeId = 'interview-helper-1';
      await addInterviewQaCard({ userDataPath: dir, nodeId, scope: 'company', card: { question: 'Why Discord?', headline: 'Because voice.' } });
      const startArgs = { nodeId, briefRecordId: 'c'.repeat(64), snapshotId: 'd'.repeat(64), canonicalJobUrl: 'https://jobs.example/1', bundleArtifactId: 'a'.repeat(64), bundleArtifactDigest: 'b'.repeat(64) };
      const load = await handlers.get('load-interview-practice')({}, { nodeId });
      assert.equal(load.session, null); assert.equal(load.bridge.connectorUrl, 'https://bridge.example.com/practice/mcp');
      status = { config: { hostname: null } };
      assert.equal((await handlers.get('start-interview-practice')({}, startArgs, new AbortController().signal)).reason, 'no_hostname');
      status = { config: { hostname: 'bridge.example.com' }, enabled: true, serving: 'live' };
      await assert.rejects(handlers.get('start-interview-practice')({}, { ...startArgs, snapshotId: 'e'.repeat(64) }, new AbortController().signal), /Prepare this interview/u, 'a brief bound to other inputs is refused');
      const started = await handlers.get('start-interview-practice')({}, startArgs, new AbortController().signal);
      assert.equal(started.ok, true); assert.equal(started.session.status, 'armed'); assert.equal(started.session.questionCount, 1);
      assert.equal(launches.length, 1); assert.match(launches[0], /interviewer from Discord/u); assert.match(launches[0], /Why Discord\?/u); assert.match(launches[0], /Discord runs on Elixir\./u);
      assert.ok(!('codeHash' in started.session));
      assert.equal((await handlers.get('start-interview-practice')({}, startArgs, new AbortController().signal)).reason, 'already_armed');
      const cancelled = await handlers.get('cancel-interview-practice')({}, { nodeId });
      assert.equal(cancelled.session.status, 'cancelled');
      launchResult = { ok: false, reason: 'login_required' };
      const failed = await handlers.get('start-interview-practice')({}, startArgs, new AbortController().signal);
      assert.equal(failed.ok, false); assert.match(failed.note, /sign in/u); assert.equal(failed.session.status, 'cancelled', 'a failed launch disarms the session');
      assert.deepEqual(notices.map(item => item.kind), ['armed', 'cancelled', 'armed', 'cancelled']);
    });
  } },
  { name: 'practice feedback view: memorized answer first, optional extension second and only when present', async run() {
    await withDom(async window => {
      const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-render-'));
      const entry = path.join(directory, 'PracticeProbe.jsx');
      const controller = new AbortController();
      let bundle;
      try {
        await fs.promises.writeFile(entry, `import React from 'react';\nimport { FeedbackView } from ${JSON.stringify(path.resolve('src/components/InterviewPracticePanel.jsx'))};\nexport function PracticeProbe({ feedback }) { return <FeedbackView feedback={feedback} />; }\n`);
        bundle = await withTimeout(bundleComponent(entry, { signal: controller.signal }), 10_000);
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.PracticeProbe, { feedback: validatePracticeFeedback(feedbackPayload('x')) })); await new Promise(resolve => setTimeout(resolve, 0)); });
        const view = window.document.querySelector('[data-testid="practice-feedback"]');
        const memorized = [...view.querySelectorAll('section[aria-label="Memorized answer"]')];
        const extensions = [...view.querySelectorAll('details.practice-extension')];
        assert.equal(memorized.length, 2, 'every planned question gets a memorized-answer section');
        assert.equal(extensions.length, 1, 'only the question with extension material gets the optional section');
        assert.ok(memorized[0].textContent.includes('Hit the headline and the example.'));
        assert.ok(extensions[0].textContent.includes('Mention the on-call rotation you ran.'));
        assert.ok(extensions[0].textContent.includes('Say this only if you can back it with a real example.'));
        assert.ok(memorized[0].compareDocumentPosition(extensions[0]) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the memorized section comes before the optional extension');
        assert.ok(extensions[0].closest('li') === memorized[0].closest('li'), 'both sections belong to the same question');
        assert.ok(view.textContent.indexOf('Work on first') < view.textContent.indexOf('Memorized answer'), 'priorities lead the report');
        await bundle.module.act(async () => { root.unmount(); });
      } finally { controller.abort(); await bundle?.dispose(); await fs.promises.rm(directory, { recursive: true, force: true }); }
    });
  } },
  { name: 'practice plan order and bridge readiness', async run() {
    const ordered = orderPracticeQuestions([{ question: 'B?' }, { question: 'A?' }, { question: 'a?' }, { question: 'C?' }], ['A?', 'Missing?', 'C?']);
    assert.deepEqual(ordered.map(card => card.question), ['A?', 'C?', 'B?']);
    assert.deepEqual(practiceBridgeReadiness({ config: { hostname: 'bridge.example.com' }, enabled: true, serving: 'live' }), { ready: true, hostname: 'bridge.example.com', connectorUrl: 'https://bridge.example.com/practice/mcp', connectorName: 'Infinite Canvas Practice', reason: null });
    assert.equal(practiceBridgeReadiness({ config: { hostname: null } }).reason, 'no_hostname');
    assert.equal(practiceBridgeReadiness({ config: { hostname: 'h.example.com' }, enabled: false }).reason, 'bridge_off');
    assert.equal(practiceBridgeReadiness({ config: { hostname: 'h.example.com' }, enabled: true, serving: 'paused' }).reason, 'not_serving');
  } },
];
