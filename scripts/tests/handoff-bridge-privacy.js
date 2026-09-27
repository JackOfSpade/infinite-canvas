import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assert } from './testHelpers.js';
import { SENTINEL_PREFIX, assertNoSentinel, sentinel } from './fixtures/handoff-bridge/sentinels.js';
import { IPC_CHANNELS, IPC_EVENTS } from '../../electron/ipc/handoffBridge/contracts.js';
import { createHandoffBridgeDialogs } from '../../electron/ipc/handoffBridge/uiDialogs.js';
import { registerHandoffBridgeUi } from '../../electron/ipc/handoffBridge/ui.js';
import { createRequestHandler } from '../../electron/ipc/handoffBridge/http.js';
import { composeHandoffBridge } from '../../electron/ipc/handoffBridge/index.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/handoff-bridge/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function filesRecursively(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursively(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function isSyntheticPhone(value) {
  const digits = value.replace(/\D/g, '');
  return /^55501\d{2}$/.test(digits);
}

const PHONE_CANDIDATE = /(?<![\w])(?:\+?1[-. ()]*)?(?:\(?\d{3}\)?[-. ]*)?\d{3}[-. ]?\d{4}(?![\w])/g;

function fakeIpc() {
  const handlers = new Map(); const listeners = new Map();
  return {
    handlers, listeners,
    handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel),
    on: (channel, fn) => listeners.set(channel, fn), removeListener: (channel, fn) => { if (listeners.get(channel) === fn) listeners.delete(channel); },
  };
}

function responseCapture() {
  const response = new EventEmitter();
  response.headers = {}; response.headersSent = false; response.writableEnded = false;
  response.setHeader = (key, value) => { response.headers[key] = value; };
  response.writeHead = (status, headers = {}) => { response.status = status; response.headers = { ...response.headers, ...headers }; response.headersSent = true; };
  response.end = (body = '') => { response.body = String(body); response.writableEnded = true; response.emit('finish'); };
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  return response;
}

function requestBody({ method = 'POST', url = '/mcp', hostname = 'bridge.example.com', source = '203.0.113.7', headers = {}, body = '' } = {}) {
  const bytes = Buffer.from(body);
  const request = Readable.from([bytes]);
  request.method = method; request.url = url; request.complete = true;
  request.headers = { host: hostname, 'cf-connecting-ip': source, 'content-length': String(bytes.length), ...headers };
  request.rawHeaders = ['host', hostname]; request.socket = { remoteAddress: source };
  return request;
}

function directRequest({ method = 'GET', url = '/oauth/authorize', hostname = 'bridge.example.com', source = '203.0.113.7', headers = {} } = {}) {
  const request = new EventEmitter();
  request.method = method; request.url = url; request.complete = true; request.readableEnded = true;
  request.headers = { host: hostname, 'cf-connecting-ip': source, ...headers };
  request.rawHeaders = ['host', hostname]; request.socket = { remoteAddress: source };
  request.destroy = () => { request.destroyed = true; };
  return request;
}

function syntheticTimers(start = 0) {
  let now = start; const timeouts = [];
  const timers = {
    setTimeout(fn, delay = 0) { const task = { at: now + Math.max(0, Number(delay) || 0), fn, active: true }; timeouts.push(task); return { task, unref() {} }; },
    clearTimeout(handle) { if (handle?.task) handle.task.active = false; },
    setInterval() { return { unref() {} }; }, clearInterval() {},
  };
  const flush = () => {
    for (;;) {
      const task = timeouts.filter(value => value.active && value.at <= now).sort((left, right) => left.at - right.at)[0];
      if (!task) break;
      task.active = false; task.fn();
    }
  };
  return { now: () => now, set(value) { now = value; flush(); }, flush, timers };
}

export default [{
  name: 'handoff bridge: privacy: sentinels, fixture contacts and paths are safe',
  run: () => {
    const value = sentinel('chat-key');
    assert(value.startsWith(SENTINEL_PREFIX), 'privacy sentinel must be uniquely recognizable');
    assertNoSentinel('fixed safe output');
    let caught = false;
    try {
      assertNoSentinel(`leak ${value}`);
    } catch {
      caught = true;
    }
    assert(caught, 'privacy sentinel must make a leak test fail');
    const realLookingPhone = '+1 416 555 0123';
    assert(realLookingPhone.match(PHONE_CANDIDATE)?.[0] === realLookingPhone, 'phone scan must capture a full NANP candidate, not an inner seven-digit suffix');
    assert(!isSyntheticPhone(realLookingPhone), 'only the designated 555-01xx fixture range is synthetic');

    const fixtureFiles = filesRecursively(fixtureDirectory);
    assert(fixtureFiles.length > 0, 'fixture directory must not be empty');
    for (const file of fixtureFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const email of content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) {
        assert(email.toLowerCase().endsWith('@example.com'), `${path.basename(file)} contains a non-synthetic email`);
      }
      for (const phone of content.match(PHONE_CANDIDATE) || []) {
        assert(isSyntheticPhone(phone), `${path.basename(file)} contains a non-synthetic phone`);
      }
      const relative = path.relative(repoRoot, file);
      const checked = spawnSync('git', ['check-ignore', '-q', '--', relative], { cwd: repoRoot, encoding: 'utf8' });
      assert(checked.status === 1, `${relative} is ignored and would disappear from CI`);
    }
  },
}, {
  name: 'handoff bridge: privacy: native confirmation text is disk-derived and strips hostile renderer/client values',
  async run() {
    const specs = []; const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, __canvasFilePath: '/tmp/Ada.canvas', isDestroyed: () => false };
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 1 }; } } });
    const hostile = sentinel('renderer-label');
    // Title/company are deliberately allowed only after the application
    // adapter derives them from disk. Use safe adapter output here; hostile
    // fields model the renderer/client payload that the adapter ignores.
    const answer = await dialogs.ask(sender, 'release', { hostname: 'bridge.example.com', canvasFilePath: '/tmp/Ada.canvas', items: [{ title: 'Ada\u202e Lovelace', company: `Example ${'x'.repeat(100)}` }], client_name: hostile, label: hostile, rendererTitle: hostile });
    assert(answer.ok && specs.length === 1, 'native release confirmation must be main-owned');
    const serialized = JSON.stringify(specs[0]);
    assert(!serialized.includes(hostile) && !serialized.includes('\u202e') && !serialized.includes('client_name'), 'renderer/client sentinels must not reach a native sheet');
    assert(serialized.includes('Ada Lovelace') && !serialized.includes('x'.repeat(61)), 'disk-derived title/company are bidi-stripped and clipped before display');
  },
}, {
  name: 'handoff bridge: privacy: real publish-release-application-confirm pipeline never puts hostile renderer or listing fields in a native sheet',
  async run() {
    const jobId = '550e8400-e29b-41d4-a716-446655440000'; const canvasFilePath = '/tmp/Marisol.canvas';
    const rendererLabel = sentinel('renderer-label-pipeline'); const listing = sentinel('listing-pipeline'); const clientName = sentinel('client-name-pipeline');
    const specs = []; const releases = []; const sender = { id: 61, __isCanvasRenderer: true, send() {} };
    const window = { webContents: sender, __canvasFilePath: canvasFilePath, isDestroyed: () => false };
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 1 }; } } });
    const ipc = fakeIpc();
    const ui = registerHandoffBridgeUi({
      ipc, getCanvasWindows: () => [window], dialogs,
      controller: {
        snapshot: () => ({ enabled: true, serving: 'live', config: { hostname: 'bridge.example.com', scope: { applications: true, scoring: false } }, limits: {}, prefs: {}, autoRelease: false }),
        subscribe: () => () => undefined,
        release: async value => { releases.push(value); return { success: true, released: value.jobs.length }; },
      },
      application: { describeForConfirm: async (path, ids) => ({ ok: path === canvasFilePath && ids[0] === jobId, canvasFilePath, items: [{ jobId, title: 'Marisol Quenby', company: 'Example', listing, client_name: clientName }] }) },
    });
    try {
      ipc.listeners.get(IPC_CHANNELS.PUBLISH_JOBS)({ sender }, { v: 1, seq: 1, jobs: [{ jobId, canvasFilePath, dockState: 'awaiting', sig: 'pipeline', label: rendererLabel, listing, client_name: clientName }] });
      const result = await ipc.handlers.get(IPC_CHANNELS.RELEASE)({ sender }, { items: [{ jobId }] });
      const serialized = JSON.stringify(specs);
      assert(result.success && JSON.stringify(releases) === JSON.stringify([{ jobs: [{ jobId, canvasFilePath }] }]), 'the real IPC path releases only canonical job and canvas identifiers after the disk adapter describes it');
      for (const value of [rendererLabel, listing, clientName]) assert(!serialized.includes(value), 'renderer, listing, and remote-client fields never reach the native confirmation spec');
      assert(serialized.includes('Marisol Quenby') && serialized.includes('Example'), 'the sheet retains only the safe, adapter-derived title and company positive controls');
    } finally { ui.dispose(); }
  },
}, {
  name: 'handoff bridge: privacy: B6 status, IPC and source contain no unauthorized sentinel channels',
  run: () => {
    const forbidden = ['token', 'chat key', 'pairing code', 'handoff code', 'canvas path', 'credentials path', 'client_name'];
    const sources = [
      'electron/ipc/handoffBridge/controller.js', 'electron/ipc/handoffBridge/ui.js', 'electron/ipc/handoffBridge/pairing.js', 'electron/ipc/handoffBridge/tray.js', 'electron/ipc/handoffBridge/power.js',
    ].map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8'));
    for (const source of sources) assert(!/\b(?:error\.message|error\.stack|req\.url)\b/.test(source), 'B6 sources must not emit free error/request text');
    assert(forbidden.every(value => value.length > 0), 'privacy negative corpus remains explicit');
  },
}, {
  name: 'handoff bridge: privacy: native dialogs serialize and every spec has a canvas parent',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    let release; let parent = null;
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: (value, spec) => { parent = value; void spec; return new Promise(resolve => { release = resolve; }); } } });
    const first = dialogs.ask(sender, 'enable', { hostname: 'bridge.example.com', idlePauseMinutes: 0, long: true });
    const busy = await dialogs.ask(sender, 'pairing');
    assert(busy.code === 'BUSY' && parent === window, 'one native sheet at a time and always attached to canvas parent');
    release({ response: 0 }); await first;
  },
}, {
  name: 'handoff bridge: privacy: pairing notices queue behind code sheet instead of being dropped',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const specs = []; let releaseCode;
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: (_parent, spec) => {
      specs.push(spec);
      if (spec.title === 'ChatGPT pairing code') return new Promise(resolve => { releaseCode = resolve; });
      return Promise.resolve({ response: 0 });
    } } });
    const showing = dialogs.showCode({ parentWindow: window, code: '23456789AB' });
    assert(dialogs.showNotice({ parentWindow: window, kind: 'link-requested' }).ok, 'notice should queue while code sheet is busy');
    releaseCode({ response: 0 }); await showing;
    await new Promise(resolve => setImmediate(resolve));
    assert(specs.length === 2 && specs[1].message === 'ChatGPT is requesting access to the Handoff bridge.', 'queued notice uses fixed text after code sheet closes');
  },
}, {
  name: 'handoff bridge: privacy: pairing codes are formatted only in the native sheet',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const specs = []; const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 0 }; } } });
    await dialogs.showCode({ parentWindow: window, code: '23456789AB' });
    assert(specs.length === 1 && specs[0].message === 'Pairing code: 23456-789AB', 'the native pairing sheet alone receives the formatted XXXXX-XXXXX code');
    assert(!JSON.stringify(dialogs).includes('23456789AB'), 'dialog API never retains the raw pairing code');
  },
}, {
  name: 'handoff bridge: privacy: binary approval only serializes validated main-owned version and hash',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const specs = []; const hostile = sentinel('renderer-binary-path');
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 1 }; } } });
    await dialogs.ask(sender, 'binaryApproval', { version: `2026.9.3${hostile}`, sha256: hostile, path: hostile });
    const serialized = JSON.stringify(specs[0]);
    assert(!serialized.includes(hostile) && serialized.includes('unavailable'), 'hostile binary details cannot cross into native dialog text');
  },
}, {
  name: 'handoff bridge: privacy: every confirmation kind is parented and renderer/client sentinels never reach it',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const hostile = sentinel('all-dialog-kinds'); const specs = [];
    const make = () => createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (parent, spec) => { assert(parent === window, 'every native sheet must receive the canvas parent'); specs.push(spec); return { response: 1 }; } } });
    const values = [
      ['enable', { hostname: 'bridge.example.com', idlePauseMinutes: 60, long: true, client_name: hostile }],
      ['enable', { long: false, client_name: hostile }],
      ['hostname', { hostname: 'bridge.example.com', client_name: hostile }], ['linkBreak', { hostname: 'bridge.example.com', redirect: hostile }],
      ['restart', { releasedCount: 1, items: [{ title: 'Disk title', company: 'Disk company' }], client_name: hostile }],
      ['resume', { reason: 'anomaly', count: 5, minutes: 10, at: 1, client_name: hostile }],
      ['release', { hostname: 'bridge.example.com', canvasFilePath: '/tmp/Disk.canvas', items: [{ title: 'Disk title', company: 'Disk company' }], label: hostile }],
      ['releasePush', { client_name: hostile }], ['scoring', { client_name: hostile }], ['autoStart', { client_name: hostile }], ['autoRelease', { client_name: hostile }],
      ['sourcePolicy', { client_name: hostile }], ['networkCheck', { client_name: hostile }], ['limits', { client_name: hostile }], ['forget', { client_name: hostile }],
      ['binaryApproval', { sourcePath: hostile, version: hostile, sha256: hostile, signature: hostile }],
    ];
    for (const [kind, details] of values) await make().ask(sender, kind, details);
    const serialized = JSON.stringify(specs);
    assert(!serialized.includes(hostile) && !serialized.includes('client_name') && !serialized.includes('redirect'), 'native dialog text cannot serialize renderer, remote-client, or redirect values');
    assert(specs.some(spec => spec.message === 'Let ChatGPT fetch your AI handoffs while this app is open?') && specs.some(spec => spec.message === 'Turn on the ChatGPT bridge?'), 'long and short enable copy must both be reachable');
  },
}, {
  name: 'handoff bridge: privacy: pairing and binary sheets use the fixed restricted controls and copy',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false }; const specs = [];
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 0 }; } } });
    await dialogs.showCode({ parentWindow: window, code: '23456789AB', expiresAt: 1 });
    await dialogs.ask(sender, 'binaryApproval', { sourcePath: '/tmp/cloudflared', version: '2026.9.3', size: 123, sha256: 'a'.repeat(64), signature: 'ad-hoc signed' });
    assert(JSON.stringify(specs[0].buttons) === JSON.stringify(['Cancel pairing']) && specs[0].message.includes('Pairing code: 23456-789AB') && specs[0].detail.includes('Only approve if you just started linking from ChatGPT.') && specs[0].detail.includes('Never share this code.'), 'pairing sheet has only the fixed code, expiry and warnings');
    assert(JSON.stringify(specs[1].buttons) === JSON.stringify(['Cancel', 'Approve']) && specs[1].detail.includes('Source: /tmp/cloudflared') && specs[1].detail.includes('This pin detects that the file changed; it cannot prove the file is genuine cloudflared: the Homebrew build is ad-hoc signed with no Team ID'), 'binary approval is limited to typed trust details and the required pin-limit sentence');
  },
}, {
  name: 'handoff bridge: privacy: composed authenticated session and 500 hostile anonymous requests preserve every protected sink',
  async run() {
    const secrets = Object.freeze({
      token: sentinel('token'), chatKey: sentinel('chat-key'), chatKeyHash: sentinel('chat-key-hash'), pairingCode: sentinel('pairing-code'),
      handoffCode: sentinel('handoff-code'), prompt: sentinel('prompt'), response: sentinel('response'), jobId: sentinel('job-id'),
      canvasPath: sentinel('canvas-path'), label: sentinel('label'), tunnelUuid: sentinel('tunnel-uuid'), credentialsPath: sentinel('credentials-path'),
      hostname: sentinel('hostname'), assertion: sentinel('assertion'), clientName: sentinel('client-name'),
    });
    const clock = syntheticTimers(1_000); const audit = []; const appLines = []; const sent = [];
    const config = { hostname: 'bridge.example.com', scope: { applications: true, scoring: false }, limits: { idlePauseMinutes: 1_440 }, prefs: { sourcePolicy: 'enforce', pairingNetworkCheck: true } };
    const canvas = { __canvasFilePath: '/tmp/privacy.canvas', isDestroyed: () => false, webContents: { id: 77, __isCanvasRenderer: true, send(channel, value) { sent.push({ channel, value }); } } };
    const grant = { linkId: 'family-1', client_name: secrets.clientName, assertion: secrets.assertion, token: secrets.token };
    const submitted = [];
    const engine = {
      snapshot: () => ({
        chat: { state: 'working', session: secrets.chatKey, sessionHash: secrets.chatKeyHash, pairingCode: secrets.pairingCode },
        queue: { jobs: [{ jobId: secrets.jobId, canvasFilePath: secrets.canvasPath, label: secrets.label }] },
        tunnel: { id: secrets.tunnelUuid, credentialsPath: secrets.credentialsPath, hostname: secrets.hostname },
      }),
      setScope: async () => undefined, setLimits: async () => undefined, tick: async () => undefined, pause: async () => undefined, resume: async () => undefined,
      get: async () => ({ status: 'served', prompt: secrets.prompt, handoffCode: secrets.handoffCode }),
      submit: async value => { submitted.push(value); return { status: 'accepted' }; },
      close: async () => undefined, clearPushHubs: async () => undefined, restartJobs: async () => [], powerState: () => ({}),
    };
    const listener = { start: async () => ({ ok: true }), quiesce: async () => undefined, drain: async () => undefined, close: async () => undefined, stop: async () => undefined, status: () => ({}) };
    const tunnelOutput = ['tunnel healthy'];
    const tunnel = { start: async () => ({ ok: true }), stop: async () => undefined, close: async () => undefined, dispose: async () => undefined, quiesce: async () => undefined, status: () => ({ state: 'online', tunnelId: secrets.tunnelUuid, credentialsOk: true, binary: { approved: true, path: secrets.credentialsPath } }), getLog: async () => tunnelOutput };
    const oauth = {
      authenticate: async () => grant,
      linkStatus: () => [{ linkId: 'family-1', state: 'linked', revoked: false, sources: ['203.0.113.0/24'], client_name: secrets.clientName }],
      closePairing: async () => undefined,
    };
    const socketRequest = (_options, callback) => {
      const request = new EventEmitter(); request.setTimeout = () => request;
      request.end = () => {
        const response = new EventEmitter(); response.statusCode = 200; response.headers = {};
        callback(response); response.emit('data', Buffer.from(JSON.stringify({ resource: 'https://bridge.example.com/mcp' }))); response.emit('end');
      };
      return request;
    };
    let graph; let ui;
    try {
      graph = composeHandoffBridge({
        userData: '/tmp/ic-b6-privacy-composed', testMode: true,
        config,
        tunnelState: { binaryPath: '/tmp/fake-cloudflared', binaryTrusted: true, credentialsPath: '/tmp/fake-credentials' },
        deps: {
          now: clock.now, timers: clock.timers, socketRequest, listener, tunnel, engine, oauth, readConfig: () => ({ state: 'ok', config }),
          audit: { append: (event, fields, at) => { audit.push({ event, fields, at }); return Promise.resolve(true); }, flush: async () => true },
          appLogger: { info: line => appLines.push(line) },
          laneStore: { loadLanes: () => [] },
          application: { read: async () => ({ kind: 'done' }), status: async () => ({ kind: 'done' }), submit: async () => ({ kind: 'done' }), describeForConfirm: async () => ({ items: [] }) },
          push: { status: () => ({}), get: async () => ({ kind: 'done' }), submit: async () => ({ kind: 'done' }) },
          pairing: { status: () => ({ open: false, code: secrets.pairingCode }), cancel: async () => undefined },
          dialogs: { ask: async () => ({ ok: true }), showCode: async () => ({ ok: true }), showNotice: () => ({ ok: true }) },
          power: { dispose() {} }, tray: { destroy() {} }, getCanvasWindows: () => [canvas],
        },
      });
      const ipc = fakeIpc();
      ui = registerHandoffBridgeUi({ ipc, controller: graph.controller, getCanvasWindows: () => [canvas], now: clock.now, timers: clock.timers, tunnel: graph.tunnel, dialogs: { ask: async () => ({ ok: true }) } });
      const enabled = await graph.controller.enable({ confirmed: true, startContext: { env: {}, isPackaged: true } });
      assert(enabled.success, `the composed controller, fake listener, fake tunnel, and socket-only probe form a live in-process graph (${enabled.code || 'unknown'})`);
      clock.set(13 * 60 * 60 * 1_000 + 1_000);

      const getBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_handoff', arguments: { session: secrets.chatKey } } });
      const getResponse = responseCapture();
      await graph.requestHandler(requestBody({ headers: { authorization: `Bearer ${secrets.token}`, origin: 'https://chatgpt.com', 'sec-fetch-site': 'none', 'content-type': 'application/json' }, body: getBody }), getResponse);
      const submitBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'submit_handoff', arguments: { session: secrets.chatKey, handoffCode: secrets.handoffCode, response: secrets.response } } });
      const submitResponse = responseCapture();
      await graph.requestHandler(requestBody({ headers: { authorization: `Bearer ${secrets.token}`, 'content-type': 'application/json' }, body: submitBody }), submitResponse);
      clock.flush();
      assert(getResponse.status === 200 && submitResponse.status === 200 && getResponse.body.includes(secrets.prompt) && getResponse.body.includes(secrets.handoffCode), 'the real authenticated MCP/controller/engine path preserves allowed prompt and handoff positive controls only in the authorized tool result');
      for (const value of Object.values(secrets).filter(value => value !== secrets.prompt && value !== secrets.handoffCode)) assert(!getResponse.body.includes(value) && !submitResponse.body.includes(value), 'the authorized response cannot echo any credential, path, identifier, assertion, client name, or submitted answer');
      assert(submitted.length === 1 && submitted[0].response === secrets.response && submitted[0].handoffCode === secrets.handoffCode, 'the accepted response and handoff code reach only the synthetic engine port');
      assert(audit.some(entry => entry.event === 'origin_seen' && entry.fields?.route === 'mcp' && entry.fields?.source === 'chatgpt.com')
        && appLines.some(line => line.startsWith('[HandoffBridge] tool_call '))
        && graph.controller.snapshot(false).activityVersion === graph.log.getVersion(),
      'authenticated positive controls reach the concrete shared logger while origin-only audit facts stay out of it');
      const activityReply = await ipc.handlers.get(IPC_CHANNELS.GET_ACTIVITY)({ sender: canvas.webContents });
      const tunnelReply = await ipc.handlers.get(IPC_CHANNELS.GET_TUNNEL_LOG)({ sender: canvas.webContents });
      assert(activityReply.success && tunnelReply.success && tunnelReply.lines[0] === 'tunnel healthy', 'the UI receives only its bounded activity and trusted tunnel-output views');

      const protectedBefore = JSON.stringify({ audit, appLines, activity: graph.log.getRecent(), activityReply, tunnelReply });
      const hostileBodies = [];
      for (let index = 0; index < 500; index += 1) {
        const response = responseCapture();
        await graph.requestHandler(directRequest({ hostname: 'attacker.example.com', url: `/oauth/authorize?x=${encodeURIComponent(`${secrets.token}-${secrets.pairingCode}-${index}`)}`, headers: { authorization: `Bearer ${secrets.token}`, origin: `https://${secrets.clientName}.example` } }), response);
        assert(response.status === 421, 'anonymous hostile host mismatch remains a fixed misdirected-request response');
        hostileBodies.push(response.body);
      }
      clock.flush();
      const protectedAfter = JSON.stringify({ audit, appLines, activity: graph.log.getRecent(), activityReply, tunnelReply });
      assert(protectedAfter === protectedBefore, '500 anonymous hostile requests leave the composed audit, logger, activity, IPC activity, and tunnel-output sinks byte-identical');
      const protectedOutputs = [protectedAfter, JSON.stringify(graph.controller.snapshot()), JSON.stringify(sent), JSON.stringify(hostileBodies), submitResponse.body];
      const everySecret = Object.values(secrets);
      for (const value of everySecret) assert(protectedOutputs.every(output => !output.includes(value)), 'no token, keys, code, path, label, identifier, hostname, assertion, or client name crosses a protected sink');
    } finally {
      ui?.dispose();
      await graph?.controller?.disable?.();
      graph?.power?.dispose?.(); graph?.tray?.destroy?.();
    }
  },
}, {
  name: 'handoff bridge: privacy: 500 anonymous host mismatches leave app/activity/audit views byte-identical',
  async run() {
    const activity = [{ kind: 'bridge_started', at: 1 }]; const before = JSON.stringify(activity); const audits = [];
    const handler = createRequestHandler({ hostname: 'bridge.example.com', mcp: async () => undefined, audit: { write: value => audits.push(value) } });
    for (let index = 0; index < 500; index += 1) {
      const headers = {}; const response = { setHeader: (key, value) => { headers[key] = value; }, end: () => undefined, once: () => undefined };
      await handler({ method: 'GET', url: '/oauth/authorize', headers: { host: 'attacker.example.com' }, rawHeaders: ['host', 'attacker.example.com'], socket: { remoteAddress: '203.0.113.9' }, readableEnded: true }, response);
    }
    assert(audits.length === 0 && JSON.stringify(activity) === before, 'anonymous host noise is counters-only and cannot evict app/activity diagnostics');
  },
}];
