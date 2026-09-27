import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { AVAILABILITY_REASONS, CHAT_STATES, EMPTY_BRIDGE_STATUS, FAULT_CODES, JOB_PHASES, JOB_REASONS, LINK_STATES, normalizeBridgeStatus, PROBE_REASONS, PROBE_STATES, TUNNEL_EXIT_CODES, TUNNEL_STATES } from '../../src/utils/handoffBridgeStatus.js';
import { __resetHandoffBridgeStoreForTests, applyHandoffBridgeStatus, getHandoffBridgeStatus, hasHandoffBridgeApi, startHandoffBridgeStatusSync } from '../../src/utils/handoffBridgeStore.js';
import { BRIDGE_ACTION_COPY, BRIDGE_COPY, BRIDGE_SETUP_COPY, IPC_ERROR_COPY, ipcErrorMessage, sanitizeTunnelLogLine } from '../../src/utils/handoffBridgeCopy.js';
import { HEALTH_IDS, describeJobRow, deriveBridgeHealth } from '../../src/utils/handoffBridgeView.js';
import { projectDockItemsForBridge, startBridgeJobPublisher } from '../../src/utils/handoffBridgeQueue.js';
import { APPLICATION_HANDOFF_LIMIT } from '../../src/utils/applicationHandoffDock.js';
import { isValidHostname, isValidPluginName, isValidSocketPath } from '../../src/utils/handoffBridgeConfig.js';

const configUrl = new URL('../../src/utils/handoffBridgeConfig.js', import.meta.url);
const copyUrl = new URL('../../src/utils/handoffBridgeCopy.js', import.meta.url);
const IMPORT_SYNTAX = /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*(?:\(|['"{*A-Za-z_$])/;
const NOW = 1_700_000_000_000;

function rawStatus(seq = 1, overrides = {}) {
  const base = { v: 1, seq, at: NOW, availability: { ok: true }, enabled: true, serving: 'live', setup: { hostnameOk: true, binaryApproved: true, credentialsOk: true, tunnelReachable: true, linked: true, toolsListed: true, firstCallSeen: true }, tunnel: { state: 'up', probe: { state: 'ok' } }, link: { state: 'linked' }, chat: { state: 'none' }, queue: { applications: {}, scoring: {} }, limits: { idlePauseMinutes: 1440 } };
  return { ...base, ...overrides, setup: { ...base.setup, ...(overrides.setup || {}) }, tunnel: { ...base.tunnel, ...(overrides.tunnel || {}), probe: { ...base.tunnel.probe, ...(overrides.tunnel?.probe || {}) } }, link: { ...base.link, ...(overrides.link || {}) }, chat: { ...base.chat, ...(overrides.chat || {}) }, queue: { ...base.queue, ...(overrides.queue || {}), applications: { ...base.queue.applications, ...(overrides.queue?.applications || {}) }, scoring: { ...base.queue.scoring, ...(overrides.queue?.scoring || {}) } } };
}

function healthFixture(id) {
  const fixtures = {
    off: rawStatus(1, { enabled: false }), setup: rawStatus(1, { setup: { linked: false } }), alarm: rawStatus(1, { alarms: [{ id: 'alarm-1', acknowledged: false }] }), fault: rawStatus(1, { fault: { code: 'internal_error' } }), paused: rawStatus(1, { paused: true, pauseCause: 'user' }), restart: rawStatus(1, { hold: 'restart' }), 'tunnel-problem': rawStatus(1, { tunnel: { state: 'failed' } }), starting: rawStatus(1, { tunnel: { state: 'starting' } }), 'tunnel-unreachable': rawStatus(1, { tunnel: { state: 'up', probe: { state: 'edge-unreachable', consecutiveFailures: 2 } } }), 'link-problem': rawStatus(1, { link: { state: 'needs-renewal' } }), 'needs-you': rawStatus(1, { queue: { applications: { needsYou: 1 } } }), 'duplicate-serve': rawStatus(1, { chat: { servedTwice: true } }), stalled: rawStatus(1, { chat: { state: 'working', outstanding: { stalled: true, stalledSince: NOW - 120000 } } }), 'chat-full': rawStatus(1, { chat: { state: 'full' } }), working: rawStatus(1, { chat: { state: 'working' } }), saving: rawStatus(1, { queue: { applications: { working: 1 } } }), 'first-call': rawStatus(1, { chat: { state: 'awaiting-first-call', ordinal: 1 } }), nudge: rawStatus(1, { queue: { applications: { ready: 1 } } }), 'chat-idle': rawStatus(1, { chat: { state: 'idle', ordinal: 1, lastCallAt: NOW - 60_000 } }), ready: rawStatus(),
  };
  return fixtures[id];
}

function seeded(seed) { let value = seed >>> 0; return () => { value = Math.imul(value ^ (value >>> 15), 1 | value); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 0x100000000; }; }

export default [
  { name: 'handoff bridge: ui: shared setup validators are import-free and reject hostile input', run: () => {
    assert({}.handoffBridgeGetStatus === undefined, 'the UI must tolerate a preload without bridge keys');
    assert(isValidHostname('b-0123456789abcdef0123.lullascape.com'), 'the production hostname shape must be accepted');
    for (const hostile of ['example.com', 'Bridge.example.com', 'bridge.example.com.', '127.0.0.1', 'bridge..example.com', 'bridge:443.example.com', 'bridge\n.example.com', 'bráce.example.com', 'xn--brce-6pa.example.com']) assert(!isValidHostname(hostile), `hostname validator must reject ${JSON.stringify(hostile)}`);
    for (const hostile of ['bad\nplugin', 'bad{plugin}', 'bad"plugin', '..']) assert(!isValidPluginName(hostile), `plugin validator must reject ${JSON.stringify(hostile)}`);
    assert(isValidPluginName('Infinite Canvas'), 'safe plugin names must remain accepted');
    assert(isValidSocketPath('/Users/ada/Library/Application Support/infinite-canvas/handoff-bridge/b.sock'), 'real Application Support socket paths with a space must be accepted');
    for (const hostile of ['relative/b.sock', '/tmp/../b.sock', '/tmp/a\n.sock', '/tmp/a:1.sock', '/tmp/a{b}.sock', '/tmp/a"b.sock', '/tmp/é.sock', `/tmp/${'x'.repeat(96)}.sock`]) assert(!isValidSocketPath(hostile), `socket validator must reject ${JSON.stringify(hostile)}`);
    const source = fs.readFileSync(configUrl, 'utf8'); assert(IMPORT_SYNTAX.test("import/* split */ { readFile } from 'node:fs';"), 'zero-import scan must recognize comment-separated import syntax'); assert(!IMPORT_SYNTAX.test(source), 'shared configuration must have zero imports');
  } },
  { name: 'handoff bridge: ui: health precedence is exhaustive and every closed enum is safe', run: () => {
    assert(HEALTH_IDS.length === 20 && new Set(HEALTH_IDS).size === HEALTH_IDS.length, 'the 20 health ids must be closed and unique');
    for (const id of HEALTH_IDS) assert(deriveBridgeHealth(healthFixture(id), NOW).id === id, `health fixture must select ${id}`);
    assert(deriveBridgeHealth(rawStatus(1, { availability: { ok: false, reason: 'e2e' } }), NOW).id === 'off', 'unavailable status must select off');
    for (const reason of AVAILABILITY_REASONS) assert(normalizeBridgeStatus(rawStatus(1, { availability: { ok: false, reason } })).availability.reason === reason, `availability enum ${reason} must survive`);
    for (const state of TUNNEL_STATES) assert(typeof normalizeBridgeStatus(rawStatus(1, { tunnel: { state } })).tunnel.state === 'string', `tunnel enum ${state} must be normalized`);
    for (const state of PROBE_STATES) assert(normalizeBridgeStatus(rawStatus(1, { tunnel: { probe: { state } } })).tunnel.probe.state === state, `probe state ${state} must be normalized`);
    assert(normalizeBridgeStatus(rawStatus(1, { tunnel: { probe: { state: 'failing' } } })).tunnel.probe.state === 'failing', 'the aggregate failing probe state must survive normalization');
    for (const reason of PROBE_REASONS) assert(normalizeBridgeStatus(rawStatus(1, { tunnel: { probe: { state: 'failing', reason } } })).tunnel.probe.reason === reason, `closed probe reason ${reason} must survive`);
    for (const reason of ['failing', 'untrusted detail', 'synthetic-token', '<script>']) assert(normalizeBridgeStatus(rawStatus(1, { tunnel: { probe: { state: 'failing', reason } } })).tunnel.probe.reason === null, `unknown probe reason ${reason} must be dropped`);
    for (const code of TUNNEL_EXIT_CODES) assert(normalizeBridgeStatus(rawStatus(1, { tunnel: { lastExit: code } })).tunnel.lastExit === code, `tunnel exit enum ${code} must be normalized`);
    for (const code of FAULT_CODES) assert(normalizeBridgeStatus(rawStatus(1, { fault: { code } })).fault?.code === code, `fault enum ${code} must be normalized`);
    for (const state of LINK_STATES) assert(typeof normalizeBridgeStatus(rawStatus(1, { link: { state } })).link.state === 'string', `link enum ${state} must be normalized`);
    for (const state of CHAT_STATES) assert(typeof normalizeBridgeStatus(rawStatus(1, { chat: { state } })).chat.state === 'string', `chat enum ${state} must be normalized`);
    const jobId = '00000000-0000-4000-8000-000000000001';
    for (const phase of JOB_PHASES) assert(typeof normalizeBridgeStatus(rawStatus(1, { queue: { jobs: [{ jobId, phase }] } })).queue.jobs[0]?.phase === 'string', `job phase ${phase} must be normalized`);
    for (const reason of JOB_REASONS) assert(normalizeBridgeStatus(rawStatus(1, { queue: { jobs: [{ jobId, phase: 'held', reason }] } })).queue.jobs[0]?.reason === reason, `job reason ${reason} must be preserved`);
    assert(normalizeBridgeStatus(rawStatus(1, { tunnel: { state: 'online' } })).tunnel.state === 'unknown', 'a raw supervisor online state is not a public renderer enum');
    assert(normalizeBridgeStatus(rawStatus(1, { tunnel: { state: 'made-up' } })).tunnel.state === 'unknown', 'unknown enum must fail closed');
    assert(normalizeBridgeStatus(rawStatus(1, { prefs: { sourcePolicy: 'off' } })).prefs.sourcePolicy === 'off', 'the accepted source-policy off value must survive normalization');
  } },
  { name: 'handoff bridge: ui: job row states retain their intended neutral and dock copy', run: () => {
    assert(describeJobRow({ phase: 'unread' }).text === 'Waiting for ChatGPT', 'an unread released job is waiting, not unreadable');
    assert(describeJobRow({ phase: 'held', reason: 'human_advance' }).text === 'Answered here; ChatGPT stopped serving it', 'a human advance must use the dock-answer copy');
  } },
  { name: 'handoff bridge: ui: status and diagnostic normalizers retain only closed safe fields', run: () => {
    const hostile = normalizeBridgeStatus(rawStatus(1, {
      fault: { code: 'Marisol Quenby 555-0101' },
      tunnel: { tunnelId: 'not-an-id', binary: { path: '/Users/ada/secret', version: 'unsafe value', sha256Prefix: 'not-a-hash' }, lastExit: 'token=synthetic-token' },
      link: { renewalCause: 'details from example.com', sources: ['Marisol Quenby', '203.0.113.0/24'] },
      queue: { jobs: [{ jobId: 'not-a-job', phase: 'awaiting', stage: 'prompt text' }] },
      push: { selectedHubs: ['Marisol Quenby'], discovered: [{ key: 'unsafe key', pending: 1 }] },
      alarms: [{ id: 'opaque-id', kind: 'untrusted text', at: 1 }],
      counts: { lastErrorCode: 'untrusted text' },
    }));
    assert(hostile.fault === null && hostile.tunnel.tunnelId === null && hostile.tunnel.binary?.path === null, 'raw fault, tunnel identifier and local path must not survive normalization');
    assert(hostile.tunnel.lastExit === null && hostile.link.renewalCause === null && hostile.link.sources.length === 1, 'diagnostic enums and sources must be closed and validated');
    assert(hostile.queue.jobs.length === 0 && hostile.push.selectedHubs.length === 0 && hostile.push.discovered.length === 0 && hostile.alarms.length === 0, 'opaque action identifiers must have strict safe shapes');
    const line = sanitizeTunnelLogLine('token=synthetic-token https://example.com/a /Users/ada/file 203.0.113.1');
    assert(line === 'token=<redacted> <url> <path> <address>', 'tunnel log lines must retain only safe diagnostic labels while redacting every sensitive value');
  } },
  { name: 'handoff bridge: ui: dynamic health detail states facts without exposing status data', run: () => {
    const setup = deriveBridgeHealth(rawStatus(1, { setup: { binaryApproved: false } }), NOW);
    assert(setup.detail.includes('approve cloudflared'), 'setup tells the person the next missing prerequisite');
    const alarm = deriveBridgeHealth(rawStatus(1, { alarms: [{ id: 'a', acknowledged: false }, { id: 'b', acknowledged: false }] }), NOW);
    assert(alarm.detail.includes('2'), 'unexpected-caller health states the refused-call count');
    const expiring = deriveBridgeHealth(rawStatus(1, { link: { expiresSoon: true } }), NOW);
    assert(expiring.headline === 'ChatGPT link expires soon', 'an expiring link has its distinct fixed health copy');
    const stale = deriveBridgeHealth(rawStatus(1, { chat: { state: 'working', outstanding: { stalled: true, stage: 'cover-letter', stalledSince: NOW - 180000 } } }), NOW);
    assert(stale.detail.includes('cover letter') && stale.detail.includes('3 min'), 'stalled health states the safe stage and elapsed time');
    const nudge = deriveBridgeHealth(rawStatus(1, { queue: { applications: { ready: 3 } } }), NOW);
    assert(nudge.badge === 3, 'badge includes the waiting-to-nudge count');
  } },
  { name: 'handoff bridge: ui: normalizer is total across 500 deterministic hostile snapshots', run: () => {
    const random = seeded(0x51a7e);
    for (let index = 0; index < 500; index += 1) { const values = [null, undefined, true, false, -1, Infinity, NaN, 'x'.repeat(500), [], {}, { nested: { deep: index } }]; const pick = () => values[Math.floor(random() * values.length)]; const raw = random() < 0.2 ? pick() : { v: random() < 0.75 ? 1 : pick(), seq: pick(), availability: pick(), tunnel: { state: pick(), probe: pick() }, link: pick(), chat: pick(), queue: { jobs: Array.from({ length: 70 }, () => pick()), applications: pick() }, alarms: Array.from({ length: 8 }, () => pick()), unknown: { token: 'synthetic-token' } }; const status = normalizeBridgeStatus(raw); assert(status && status.v === 1 && typeof status.availability?.ok === 'boolean', `snapshot ${index} must normalize to a safe shape`); assert(status.queue.jobs.length <= 50 && status.alarms.length <= 5, `snapshot ${index} must cap arrays`); assert(!Object.hasOwn(status, 'unknown'), `snapshot ${index} must drop unknown fields`); }
  } },
  { name: 'handoff bridge: ui: copy, IPC and dock publication contracts cannot drift', run: () => {
    for (const id of HEALTH_IDS) assert(Array.isArray(BRIDGE_COPY.health[id]) && BRIDGE_COPY.health[id].every(Boolean), `health id ${id} must have copy`);
    for (const [id, label] of Object.entries(BRIDGE_ACTION_COPY)) assert(typeof label === 'string' && label, `action ${id} must have copy`);
    for (const code of Object.keys(IPC_ERROR_COPY)) assert(ipcErrorMessage(code) === IPC_ERROR_COPY[code], `IPC code ${code} must have exact copy`);
    assert(ipcErrorMessage('NOT_A_CODE') === IPC_ERROR_COPY.INTERNAL, 'unknown IPC codes must have a fixed fallback');
    assert(BRIDGE_SETUP_COPY.tunnelCommandList[2] === 'cloudflared tunnel route dns <UUID_FROM_CREATE_OUTPUT> bridge.your-domain.com', 'tunnel setup must route with the UUID printed by create');
    assert(BRIDGE_SETUP_COPY.tunnelCommands.toLowerCase().includes('do not route by name'), 'tunnel setup must warn that a default config can make name routing unsafe');
    const copySource = fs.readFileSync(copyUrl, 'utf8');
    assert(!copySource.includes('cloudflared tunnel route dns NAME'), 'renderer copy must never instruct cloudflared to route DNS by tunnel name');
    const items = Array.from({ length: APPLICATION_HANDOFF_LIMIT + 4 }, (_, index) => ({ kind: 'application', jobId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, canvasFilePath: `/tmp/${index}.canvas`, handoffCode: `code-${index}`, prompt: 'synthetic', label: `Marisol Quenby ${index}`, stage: 'resume' })); const projected = projectDockItemsForBridge(items.reverse());
    assert(projected.length === APPLICATION_HANDOFF_LIMIT, 'dock projection must retain its fixed application limit'); assert(projected.every(item => !Object.hasOwn(item, 'label') && Object.hasOwn(item, 'sig')), 'publication projection may never contain renderer labels');
    const duplicate = { ...items[0], canvasFilePath: '/tmp/duplicate.canvas', handoffCode: 'other-code' }; const forward = projectDockItemsForBridge([items[0], duplicate]); const reverse = projectDockItemsForBridge([duplicate, items[0]]);
    assert(JSON.stringify(forward) === JSON.stringify(reverse), 'duplicate dock items must project deterministically regardless of discovery order');
    const sent = []; let timer; let interval; const stop = startBridgeJobPublisher({ api: { handoffBridgePublishJobs: payload => sent.push(payload) }, subscribe: listener => { listener(); return () => {}; }, getItems: () => items, setTimer: fn => { timer = fn; return 1; }, clearTimer: () => { timer = null; }, setIntervalFn: fn => { interval = fn; return 2; }, clearIntervalFn: () => { interval = null; } }); timer?.(); interval?.(); stop();
    assert(sent.length >= 2 && sent.every(payload => payload.jobs.every(job => !Object.hasOwn(job, 'label'))), 'all publisher payloads must exclude labels'); assert(sent.at(-1).unmount === true && sent.at(-1).jobs.length === 0, 'publisher must clear its sender on unmount');
  } },
  { name: 'handoff bridge: ui: status store ref-counts, rejects stale generations and survives no preload', async run() {
    __resetHandoffBridgeStoreForTests(); assert(!hasHandoffBridgeApi({}), 'an older preload has no bridge API'); const missingStop = startHandoffBridgeStatusSync({}); missingStop();
    let callback; let unsubscribed = 0; let resolveGet; const api = { onHandoffBridgeStatus(listener) { callback = listener; return () => { unsubscribed += 1; }; }, handoffBridgeGetStatus() { return new Promise(resolve => { resolveGet = resolve; }); } };
    const first = startHandoffBridgeStatusSync(api); const second = startHandoffBridgeStatusSync(api); assert(typeof callback === 'function', 'sync subscribes before status replay'); callback(rawStatus(8)); assert(getHandoffBridgeStatus().seq === 8, 'event during replay must not be lost'); await Promise.resolve(); assert(typeof resolveGet === 'function', 'status replay must be scheduled after listener registration'); first(); assert(unsubscribed === 0, 'one remaining reference must keep IPC listener alive'); second(); assert(unsubscribed === 1, 'last reference must unsubscribe exactly once'); resolveGet(rawStatus(99)); await Promise.resolve(); await Promise.resolve(); assert(getHandoffBridgeStatus().seq === 8, 'stale async replay after stop must not update the store');
    applyHandoffBridgeStatus(rawStatus(9)); applyHandoffBridgeStatus(rawStatus(8)); applyHandoffBridgeStatus(rawStatus(9)); assert(getHandoffBridgeStatus().seq === 9, 'store must ignore stale and equal snapshots'); __resetHandoffBridgeStoreForTests(); assert(getHandoffBridgeStatus() === EMPTY_BRIDGE_STATUS, 'test reset must restore empty stable snapshot');
  } },
];
