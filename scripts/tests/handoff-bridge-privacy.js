import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assert } from './testHelpers.js';
import { generateMarkdown } from '../test-dependencies.js';
import { SENTINEL_PREFIX, assertNoSentinel, sentinel } from './fixtures/handoff-bridge/sentinels.js';
import { IPC_CHANNELS, IPC_EVENTS } from '../../electron/ipc/handoffBridge/contracts.js';
import { createHandoffBridgeDialogs } from '../../electron/ipc/handoffBridge/uiDialogs.js';
import { registerHandoffBridgeUi } from '../../electron/ipc/handoffBridge/ui.js';
import { createRequestHandler } from '../../electron/ipc/handoffBridge/http.js';
import { composeHandoffBridge, resolveTestMode, tunnelLogLinesForUi } from '../../electron/ipc/handoffBridge/index.js';
import { CONSTANTS } from '../../electron/ipc/handoffBridge/constants.js';
import { createHandoffEngine } from '../../electron/ipc/handoffBridge/engine.js';
import { createLaneStore } from '../../electron/ipc/handoffBridge/laneStore.js';
import { createHandoffBridgeLog } from '../../electron/ipc/handoffBridge/log.js';
import {
  redactReportUrl,
  redactReportUrlsInText,
  setReportRedactedHosts,
} from '../../electron/ipc/bugReport/helpers.js';
import { clearBridgeQueueDiagnostic, getBridgeQueueDiagnostic, reduceBridgeQueue, retireBridgeQueueDiagnosticProvider, setBridgeQueueDiagnosticProvider, clearClientAuthDiagnostic, clearFailedStartDiagnostic, clearOAuthRejectionDiagnostic, clearSourceRejectionDiagnostic, getFailedStartDiagnosticLines, recordClientAuthDiagnostic, recordFailedStartDiagnostic, recordOAuthRejectionDiagnostic, recordSourceRejectionDiagnostic } from '../../electron/ipc/handoffBridge/telemetry.js';

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
  name: 'handoff bridge: privacy: FULL reports retain only opted-in closed failed-start diagnostics',
  async run() {
    const base = {
      description: 'Bridge enable failed.', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
    };
    try {
      recordFailedStartDiagnostic({
        telemetry: true, phase: 'tunnel-start', cause: 'config-rejected', startedAt: 1_000, at: 2_500,
        tunnel: {
          state: 'failed', lastExit: 'config-rejected', binaryPath: '/private/secret', hostname: 'private.example.test',
          probe: { state: 'failing', reason: 'hostile injected value', consecutiveFailures: 4, rawLog: 'PRIVATE_BRIDGE_LOG' },
          readiness: { configurationValidated: true, environmentHealthy: true, localReadinessPassed: true, registeredConnectionCount: 999, connectorId: 'PRIVATE_CONNECTOR_ID' },
        },
      });
      const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      const focused = generateMarkdown({ ...base, filterCode: 'JOBS' }).markdown;
      assert(full.includes('## Handoff Bridge Diagnostics') && full.includes('phase `tunnel-start`') && full.includes('cause `config-rejected`')
        && full.includes('reason `unknown`') && full.includes('Configuration validation: passed · environment check: healthy · local readiness: passed · observed registered tunnel connections: 8')
        && full.includes('elapsed 1500 ms') && !focused.includes('## Handoff Bridge Diagnostics'),
      'only FULL reports render the opted-in failed-start receipt');
      for (const privateValue of ['/private/secret', 'private.example.test', 'PRIVATE_BRIDGE_LOG', 'PRIVATE_CONNECTOR_ID', 'hostile injected value']) {
        assert(!full.includes(privateValue), `handoff diagnostics must drop hostile/private value ${privateValue}`);
      }
      const retained = getFailedStartDiagnosticLines();
      const afterDisposal = await tunnelLogLinesForUi(null);
      assert(JSON.stringify(retained) === JSON.stringify(afterDisposal)
        && retained.includes('Bridge startup failed: tunnel-start.')
        && retained.includes('Startup cause: config-rejected.')
        && retained.includes('Configuration validation: passed; environment check: healthy; local readiness: passed.')
        && retained.includes('Observed registered tunnel connections: 8.')
        && retained.every(line => !['/private/secret', 'private.example.test', 'PRIVATE_BRIDGE_LOG', 'PRIVATE_CONNECTOR_ID', 'hostile injected value'].some(secret => line.includes(secret))),
      'the disposed tunnel-log fallback must retain only bounded closed diagnostic facts');
      const liveEmpty = await tunnelLogLinesForUi({ getLog: async () => [] });
      const liveThrow = await tunnelLogLinesForUi({ getLog: async () => { throw new Error('unavailable'); } });
      assert(liveEmpty.length === 0 && liveThrow.length === 0,
        'a live supervisor owns its empty or failed log view and must never receive an older failed-start receipt');
      recordFailedStartDiagnostic({ telemetry: false, phase: 'tunnel-readiness', cause: 'readiness-timeout', tunnel: { state: 'connecting' } });
      assert(!generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('## Handoff Bridge Diagnostics'),
        'telemetry opt-out must omit the failed-start receipt entirely');
      assert(getFailedStartDiagnosticLines().length === 0 && (await tunnelLogLinesForUi(null)).length === 0,
        'the post-disposal tunnel-log fallback must respect diagnostics opt-out');
    } finally { clearFailedStartDiagnostic(); }
  },
}, {
  name: 'handoff bridge: privacy: FULL reports render only closed opted-in OAuth origin-refusal facts',
  run: () => {
    const privateOrigin = 'https://private-origin.example.test:8443/with?state=PRIVATE_STATE&code=PRIVATE_CODE';
    const privateTarget = '/oauth/authorize?redirect_uri=https%3A%2F%2Fprivate-client.example.test%2Fcallback&state=PRIVATE_STATE';
    const base = {
      description: 'The OAuth authorization page was refused.', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
    };
    try {
      // A hostile caller cannot smuggle a raw request string through the
      // recorder: every field is closed to an enum before retention.
      recordOAuthRejectionDiagnostic({ telemetry: true, route: privateTarget, method: 'DELETE', reason: privateOrigin, stage: privateOrigin, fetchSite: 'PRIVATE_STATE', fetchMode: privateTarget, fetchDest: privateOrigin, originShape: 'PRIVATE_CODE', consentAction: privateTarget, hasTxn: privateOrigin, consentPolicyVersion: privateTarget, at: 2_000 });
      recordOAuthRejectionDiagnostic({ telemetry: true, route: 'authorize', method: 'POST', reason: 'fetch-site', stage: 'http', fetchSite: 'cross-site', fetchMode: 'other', fetchDest: 'other', originShape: 'chatgpt-exact', consentAction: 'uninspected', hasTxn: 'uninspected', consentPolicyVersion: 'document-navigation-v2', at: 2_500 });
      recordOAuthRejectionDiagnostic({ telemetry: true, route: 'authorize', method: 'POST', reason: 'origin-mismatch', stage: 'consent', fetchSite: 'same-origin', fetchMode: 'navigate', fetchDest: 'other', originShape: 'https-other', consentAction: 'approve', hasTxn: 'yes', consentPolicyVersion: 'document-navigation-v2', at: 3_000 });
      const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      const focused = generateMarkdown({ ...base, filterCode: 'JOBS' }).markdown;
      const bridge = generateMarkdown({ ...base, filterCode: 'BRIDGE' }).markdown;
      assert(full.includes('## Handoff Bridge Diagnostics')
        && full.includes('OAuth cross-origin refusals: 3')
        && full.includes('route `authorize`')
        && full.includes('method `POST`')
        && full.includes('stage `consent`')
        && full.includes('reason `origin-mismatch`')
        && full.includes('fetch site `same-origin`')
        && full.includes('fetch mode `navigate`')
        && full.includes('fetch destination `other`')
        && full.includes('Origin shape `https-other`')
        && full.includes('consent action `approve`')
        && full.includes('transaction `yes`')
        && full.includes('consent policy `document-navigation-v2`')
        && full.includes('status 403')
        && bridge.includes('OAuth cross-origin refusals: 3')
        && !focused.includes('OAuth cross-origin refusals'),
      'FULL and the focused BRIDGE code make the closed last refusal actionable');
      for (const secret of [privateOrigin, privateTarget, 'PRIVATE_STATE', 'PRIVATE_CODE', 'private-origin.example.test', 'private-client.example.test']) {
        assert(!full.includes(secret), `OAuth refusal diagnostics must not retain raw request data (${secret})`);
      }
      clearOAuthRejectionDiagnostic();
      recordOAuthRejectionDiagnostic({ telemetry: false, route: 'authorize', method: 'POST', reason: 'fetch-site', stage: 'http', fetchSite: 'cross-site', fetchMode: 'other', fetchDest: 'other', originShape: 'chatgpt-exact', consentAction: 'uninspected', hasTxn: 'uninspected', consentPolicyVersion: 'document-navigation-v2' });
      assert(!generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('OAuth cross-origin refusals'),
        'the diagnostics opt-out cannot retain a later OAuth refusal');
    } finally { clearOAuthRejectionDiagnostic(); }
  },
}, {
  // A refused source answers a 401 that is deliberately identical to an
  // expired-token 401. Without this line the real cause -- the connector's
  // egress leaving the pinned prefixes -- is invisible in a report.
  name: 'handoff bridge: privacy: FULL reports name a refused caller network without retaining its address',
  run: () => {
    const privateAddress = '203.0.113.77';
    const privatePrefix = '203.0.113.0/24';
    const base = {
      description: 'The bridge refused a caller network.', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
    };
    try {
      recordSourceRejectionDiagnostic({ telemetry: true, route: privateAddress, mode: privatePrefix, sourceClass: privateAddress, links: privatePrefix, at: 4_000 });
      recordSourceRejectionDiagnostic({ telemetry: true, route: 'mcp', mode: 'enforce', sourceClass: 'other-public', links: 'one', at: 4_500 });
      const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      const focused = generateMarkdown({ ...base, filterCode: 'JOBS' }).markdown;
      const bridge = generateMarkdown({ ...base, filterCode: 'BRIDGE' }).markdown;
      assert(full.includes('Refused caller networks: 2')
        && full.includes('last route `mcp`')
        && full.includes('policy `enforce`')
        && full.includes('caller network class `other-public`')
        && full.includes('active links `one`')
        && full.includes('refused for its NETWORK, not its token')
        && full.includes('Disconnect the existing link FIRST')
        && bridge.includes('Refused caller networks: 2')
        && !focused.includes('Refused caller networks'),
      'FULL and BRIDGE must state the refused-network cause and its recovery');
      // A hostile or buggy caller cannot push an address through the closed enums.
      for (const secret of [privateAddress, privatePrefix, '203.0.113']) {
        assert(!full.includes(secret), `source-refusal diagnostics must not retain a caller address (${secret})`);
      }
      clearSourceRejectionDiagnostic();
      recordSourceRejectionDiagnostic({ telemetry: false, route: 'mcp', mode: 'enforce', sourceClass: 'other-public', links: 'one' });
      assert(!generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('Refused caller networks'),
        'the diagnostics opt-out cannot retain a later source refusal');
    } finally { clearSourceRejectionDiagnostic(); }
  },
}, {
  // The token endpoint computed this outcome and dropped it, so the choice
  // between pinning private_key_jwt and accepting none had no evidence.
  name: 'handoff bridge: privacy: FULL reports state which client authentication the connector used',
  run: () => {
    const privateAssertion = 'PRIVATE_CLIENT_ASSERTION_JWT';
    const base = {
      description: 'Client authentication observation.', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
    };
    try {
      recordClientAuthDiagnostic({ telemetry: true, outcome: privateAssertion, at: 5_000 });
      const unknown = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      assert(unknown.includes('method `unknown`') && !unknown.includes(privateAssertion),
        'an unrecognised outcome must close to unknown and never retain the raw value');

      // A signed CODE exchange alone must not read as permission to pin:
      // client authentication also runs for refresh_token.
      clearClientAuthDiagnostic();
      recordClientAuthDiagnostic({ telemetry: true, outcome: 'assertion_ok', grant: 'authorization_code', at: 5_500 });
      const signed = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      const bridge = generateMarkdown({ ...base, filterCode: 'BRIDGE' }).markdown;
      const focused = generateMarkdown({ ...base, filterCode: 'JOBS' }).markdown;
      assert(signed.includes('Client authentication observed: 1')
        && signed.includes('last grant `authorization_code`')
        && signed.includes('method `assertion`')
        && signed.includes('signed refresh seen `no`')
        && signed.includes('NOT yet enough to pin')
        && bridge.includes('method `assertion`')
        && !focused.includes('Client authentication observed'),
      'a signed code exchange alone must not read as permission to pin');

      // Once a signed refresh is seen the verdict flips, and it stays flipped
      // even if a later exchange is a code grant again.
      recordClientAuthDiagnostic({ telemetry: true, outcome: 'assertion_ok', grant: 'refresh_token', at: 5_700 });
      const refreshed = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      assert(refreshed.includes('signed refresh seen `yes`') && refreshed.includes('can be pinned to private_key_jwt'),
        'a signed refresh must license the pin');
      recordClientAuthDiagnostic({ telemetry: true, outcome: 'assertion_ok', grant: 'authorization_code', at: 5_900 });
      assert(generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('signed refresh seen `yes`'),
        'a later code exchange cannot erase a signed refresh already observed');

      clearClientAuthDiagnostic();
      recordClientAuthDiagnostic({ telemetry: true, outcome: 'none', at: 6_000 });
      assert(generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('method `none`'),
        'an unsigned token exchange must be reported as none, not inferred as assertion');

      clearClientAuthDiagnostic();
      recordClientAuthDiagnostic({ telemetry: false, outcome: 'assertion_ok' });
      assert(!generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('Client authentication observed'),
        'the diagnostics opt-out cannot retain a client-authentication observation');
    } finally { clearClientAuthDiagnostic(); }
  },
}, {
  name: 'handoff bridge: privacy: FULL issue-reporter draft diagnostics retain only closed state and bounded length',
  run: () => {
    const privateLocalDraft = 'PRIVATE_ISSUE_REPORTER_LOCAL_DRAFT';
    const privateSessionDraft = 'PRIVATE_ISSUE_REPORTER_SESSION_DRAFT';
    const privateStorageError = 'PRIVATE_ISSUE_REPORTER_STORAGE_ERROR';
    const base = {
      description: 'Issue reporter draft persistence check.', filterCode: 'FULL',
      nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [],
    };
    const present = generateMarkdown({
      ...base,
      issueReporterDraft: {
        localStorageStatus: 'available', localStoragePresent: true, localStorageLength: 71,
        localStoragePrefix: privateLocalDraft,
        sessionStorageStatus: 'available', sessionStoragePresent: true, sessionStorageLength: 1_000_001,
        sessionStoragePrefix: privateSessionDraft,
      },
    }).markdown;
    const unavailable = generateMarkdown({
      ...base,
      issueReporterDraft: {
        localStorageStatus: 'unavailable', localStoragePresent: true, localStorageLength: 71,
        localStorageError: privateStorageError,
        sessionStorageStatus: 'unavailable', sessionStoragePresent: true, sessionStorageLength: 71,
        sessionStorageError: privateStorageError,
      },
    }).markdown;
    for (const report of [present, unavailable]) {
      for (const secret of [privateLocalDraft, privateSessionDraft, privateStorageError]) {
        assert(!report.includes(secret), 'FULL must never export issue-reporter draft or storage-error text');
      }
    }
    assert(present.includes('LocalStorage legacy draft: `Present (length: 71)`')
      && present.includes('SessionStorage draft (current session): `Present (length: 1000000)`')
      && unavailable.includes('LocalStorage legacy draft: `Unavailable`')
      && unavailable.includes('SessionStorage draft (current session): `Unavailable`'),
    'FULL preserves closed availability, presence, and bounded draft length diagnostics');
    return { privacySafe: true };
  },
}, {
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
    // The tracking check below needs a readable index. CI runs this from a
    // detached worktree whose `.git` is a FILE pointing back at the main
    // repository, and that target is not always mounted alongside it -- there
    // `git` fails for every path at once, which is an unreadable repository,
    // not an untracked fixture. Probe once and only assert on a verdict git
    // can actually give, so a real untracked fixture still fails loudly.
    const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, encoding: 'utf8' });
    const indexReadable = !probe.error && probe.status === 0 && String(probe.stdout).trim() === 'true';
    for (const file of fixtureFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const email of content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) {
        assert(email.toLowerCase().endsWith('@example.com'), `${path.basename(file)} contains a non-synthetic email`);
      }
      for (const phone of content.match(PHONE_CANDIDATE) || []) {
        assert(isSyntheticPhone(phone), `${path.basename(file)} contains a non-synthetic phone`);
      }
      if (!indexReadable) continue;
      const relative = path.relative(repoRoot, file);
      const checked = spawnSync('git', ['ls-files', '--error-unmatch', '--', relative], { cwd: repoRoot, encoding: 'utf8' });
      // Name the file: the previous message said only that "a" fixture was
      // untracked, which cost a full CI round to localize.
      assert(!checked.error && checked.status === 0,
        `${relative} is not tracked and would disappear from CI (git exit ${checked.error ? 'unavailable' : checked.status}).`);
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
  // createOAuthServer defaults every observation callback to a no-op, so a
  // sink that composition forgets to pass fails silently and forever: the
  // token endpoint computed the client-authentication outcome and dropped it.
  // Pin the wiring, not just the sink.
  name: 'handoff bridge: privacy: composition passes every bridge observation sink it declares',
  run: () => {
    const index = fs.readFileSync(path.join(repoRoot, 'electron/ipc/handoffBridge/index.js'), 'utf8');
    for (const sink of ['recordClientAuth:', 'recordOAuthRejection:', 'recordSourceRejection:']) {
      assert(index.includes(sink), `composition must pass ${sink.replace(':', '')} or its observation is silently discarded`);
    }
    for (const [sink, recorder] of [['recordClientAuth', 'recordClientAuthDiagnostic'], ['recordSourceRejection', 'recordSourceRejectionDiagnostic']]) {
      assert(index.includes(recorder), `${sink} must reach ${recorder}`);
    }
    // Wiring the sink is not enough: a forwarder that names only some fields
    // silently degrades the rest to their enum fallback. `grant` decides
    // whether requiring a client assertion is safe, and it was dropped here
    // once already while `outcome` came through intact.
    const forwarder = index.slice(index.indexOf('recordClientAuth:'), index.indexOf('recordClientAuthDiagnostic(') + 200);
    for (const field of ['outcome', 'grant']) {
      assert(new RegExp(`${field}:\\s*entry\\?\\.${field}`).test(forwarder),
        `the recordClientAuth forwarder must pass ${field} through, or it degrades to unknown in the report`);
    }
    // Every telemetry recorder composition imports must also be cleared, or a
    // stale observation outlives the link it described.
    for (const cleared of ['clearClientAuthDiagnostic', 'clearOAuthRejectionDiagnostic', 'clearSourceRejectionDiagnostic', 'clearBridgeQueueDiagnostic']) {
      assert(index.includes(`${cleared}()`), `${cleared} must be called so a stale observation cannot outlive its link`);
    }
  },
}, {
  name: 'handoff bridge: privacy: FULL reports show the application lane queue as closed enums and integers only, and only while opted in',
  run: () => {
    const base = { description: 'A discarded bundle.', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [] };
    const JOB_UUID = '01f8d94c-6fd3-4a2b-8c5e-0123456789ab';
    const secret = '/Users/jack/Desktop/Job Search/Ada Lovelace resume PRIVATE_PROMPT https://private.example.test/x?code=PRIVATE_CODE';
    let enabled = true;
    const raw = () => (enabled ? {
      at: 100_000, enabled: true, serving: 'live', autoRelease: true, paused: null, fault: null,
      queue: { ready: 0, working: 2, needsYou: 0, held: 0, done: 0 },
      chat: { state: 'working', jobsAssigned: 1, jobsCap: 2, note: secret },
      lanes: [
        { jobId: JOB_UUID, phase: 'unread', stage: null, reason: null, servedToChat: null, changedAt: 40_000, canvasFilePath: secret, title: secret },
        { jobId: secret, phase: secret, stage: secret, reason: secret, servedToChat: 3, changedAt: 99_000 },
        { jobId: '11111111-1111-4111-8111-111111111111', phase: secret, stage: secret, reason: secret, servedToChat: 3, changedAt: 99_000 },
      ],
      counts: { releaseCalls: 3, releaseNoops: 2, unreleaseCalls: 0, lanesDropped: 4, droppedDiscarded: 1, droppedPruned: 1, droppedMissing: 1, droppedSaved: 1, prompt: secret },
    } : null);
    try {
      setBridgeQueueDiagnosticProvider(raw);
      const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      const bridge = generateMarkdown({ ...base, filterCode: 'BRIDGE' }).markdown;
      const focused = generateMarkdown({ ...base, filterCode: 'JOBS' }).markdown;
      assert(full.includes('## Handoff Bridge Diagnostics') && full.includes('job `01f8d94c` · phase `unread` · stage `none` · reason `none` · served to current chat `no` · in this phase 1m'),
        'the report shows the lane a discarded bundle would leave behind, by its 8-hex prefix and closed phase');
      assert(full.includes('live lanes 2/10') && full.includes('release calls 3 (added nothing: 2)') && full.includes('lanes dropped by the app 4 (discard event 1 · prune event 1 · status probe found the bundle gone 1 · status probe reported it saved 1)'), 'queue capacity and lifecycle counters are visible, each drop cause by what was observed');
      assert(!full.includes('discarded or pruned'), 'a dropped lane is never labelled with a cause that was not observed');
      assert(full.includes('job `11111111` · phase `unread`') && full.includes('served to current chat `yes`'), 'a hostile enum falls back to a closed value');
      assert(bridge.includes('Application lanes') && !focused.includes('Application lanes'), 'FULL and BRIDGE carry it; other focus codes do not');
      for (const leaked of ['PRIVATE_PROMPT', 'PRIVATE_CODE', '/Users/jack', 'Ada Lovelace', 'private.example.test', JOB_UUID, '6fd3-4a2b']) {
        assert(!full.includes(leaked), `the lane view must never carry ${leaked}`);
      }
      enabled = false;
      assert(!generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('Application lanes'), 'the provider withholds it when report telemetry is opted out');
      enabled = true;
      const provider = raw;
      setBridgeQueueDiagnosticProvider(provider);
      retireBridgeQueueDiagnosticProvider(() => null);
      assert(getBridgeQueueDiagnostic() !== null && generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('Application lanes'), 'a stale runtime cannot retire a newer provider');
      retireBridgeQueueDiagnosticProvider(provider);
      enabled = false;
      assert(generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('job `01f8d94c`'), 'a retired runtime leaves its final view for a report generated afterwards');
      clearBridgeQueueDiagnostic();
      assert(getBridgeQueueDiagnostic() === null && !generateMarkdown({ ...base, filterCode: 'FULL' }).markdown.includes('Application lanes'), 'clearing removes it');
    } finally { clearBridgeQueueDiagnostic(); }
  },
}, {
  name: 'handoff bridge: privacy: the lane report names a failed bridge, keeps live lanes ahead of finished ones, and counts live lanes from the queue rather than the truncated list',
  run: () => {
    const base = { description: 'A busy queue.', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [] };
    const uuid = index => `${(0xa0000000 + index).toString(16)}-1111-4111-8111-111111111111`;
    // 25 finished lanes listed FIRST (oldest in array order), then 4 live ones.
    const finished = Array.from({ length: 25 }, (_unused, index) => ({ jobId: uuid(index), phase: index % 2 ? 'done' : 'gone', changedAt: 1_000 + index }));
    const live = [
      { jobId: uuid(100), phase: 'held', reason: 'restart', changedAt: 50_000 },
      { jobId: uuid(101), phase: 'awaiting', stage: 'resume', changedAt: 60_000, servedToChat: 1 },
      { jobId: uuid(102), phase: 'unread', changedAt: 70_000 },
      { jobId: uuid(103), phase: 'host', changedAt: 80_000 },
      // A live lane the list cannot show (no usable id): only the queue counts know about it.
      { jobId: 'not-a-job-id', phase: 'unread', changedAt: 90_000 },
    ];
    const raw = { at: 100_000, enabled: false, serving: 'error', autoRelease: false, paused: null, fault: null,
      queue: { ready: 1, working: 3, needsYou: 1, held: 1, done: 25 }, chat: { state: 'none', jobsAssigned: 0, jobsCap: 2 },
      lanes: [...finished, ...live], counts: {} };
    const reduced = reduceBridgeQueue(raw);
    assert(reduced.serving === 'error', `a failed bridge must read as error, not ${reduced.serving}`);
    assert(reduced.lanes.length === 19, 'the list is bounded to 20 slots (one is spent on the lane with no usable id, which is not listed)');
    assert(reduced.lanes.slice(0, 4).every(lane => ['held', 'awaiting', 'unread', 'host'].includes(lane.phase)), 'every live lane comes before any finished lane');
    const finishedRows = reduced.lanes.slice(4);
    assert(finishedRows.length === 15 && finishedRows[0].job === uuid(24).slice(0, 8) && finishedRows.every((lane, position) => position === 0 || lane.ageSeconds >= finishedRows[position - 1].ageSeconds),
      'the room left over goes to the most recently changed finished lanes, newest first');
    assert(reduced.liveLanes === 5 && reduced.lanes.length === 19, `live lanes come from the queue counts (5), not from the rows that could be listed, got ${reduced.liveLanes}`);
    try {
      setBridgeQueueDiagnosticProvider(() => raw);
      const full = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      assert(full.includes('serving `error`') && !full.includes('serving `unknown`'), 'the report must not print a failed bridge as unknown');
      assert(full.includes('live lanes 5/10'), 'the report shows the live count from the queue, not from the truncated rows');
      for (const index of [100, 101, 102, 103]) assert(full.includes(`job \`${uuid(index).slice(0, 8)}\``), 'each live lane is listed');
    } finally { clearBridgeQueueDiagnostic(); }
  },
}, {
  // The client-authentication policy is relaxed for TEST mode, which has no
  // network to fetch the connector's JWKS. That relaxation must never be
  // reachable from a packaged app, and production must stay pinned.
  name: 'handoff bridge: privacy: the client-authentication relaxation is confined to unpackaged TEST mode',
  run: () => {
    assert(CONSTANTS.TOKEN_AUTH_MODE === 'require-assertion',
      'production must require a signed client assertion');
    assert(CONSTANTS.AS_AUTH_METHODS.length === 1 && CONSTANTS.AS_AUTH_METHODS[0] === 'private_key_jwt',
      'production must advertise private_key_jwt alone, so `none` is never offered');
    // resolveTestMode is the only gate on the relaxation: it must refuse a
    // packaged app outright, whatever the environment claims.
    const packaged = resolveTestMode({
      env: { INFINITE_CANVAS_HANDOFF_BRIDGE_TEST: '1' }, isPackaged: true,
      paths: { binaryPath: '/tmp/a', credentialsPath: '/tmp/b', userData: '/tmp/c' },
      tmpdir: '/tmp', realpath: value => value,
    });
    assert(packaged === false, 'a packaged app can never enter TEST mode, so it can never relax client authentication');
    const outsideTmp = resolveTestMode({
      env: { INFINITE_CANVAS_HANDOFF_BRIDGE_TEST: '1' }, isPackaged: false,
      paths: { binaryPath: '/Users/someone/a', credentialsPath: '/tmp/b', userData: '/tmp/c' },
      tmpdir: '/tmp', realpath: value => value,
    });
    assert(outsideTmp === false, 'TEST mode must refuse paths outside tmp');
    const index = fs.readFileSync(path.join(repoRoot, 'electron/ipc/handoffBridge/index.js'), 'utf8');
    assert(/tokenAuthMode:\s*testMode\s*\?/.test(index) && /asAuthMethods:\s*testMode\s*\?/.test(index),
      'the relaxation must be conditioned on testMode, never applied unconditionally');
  },
}, {
  name: 'handoff bridge: privacy: native dialogs serialize and every spec has a canvas parent',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    let release; let parent = null;
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: (value, spec) => { parent = value; void spec; return new Promise(resolve => { release = resolve; }); } } });
    const first = dialogs.ask(sender, 'enable', { hostname: 'bridge.example.com', idlePauseMinutes: 0, long: true });
    const busy = await dialogs.ask(sender, 'linkBreak', { hostname: 'bridge.example.com' });
    assert(busy.code === 'BUSY' && parent === window, 'one native sheet at a time and always attached to canvas parent');
    release({ response: 0 }); await first;
  },
}, {
  name: 'handoff bridge: privacy: pairing progress never stacks behind the code sheet',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const specs = []; let releaseCode;
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: (_parent, spec) => {
      specs.push(spec);
      if (spec.title === 'ChatGPT pairing code') return new Promise(resolve => { releaseCode = resolve; });
      return Promise.resolve({ response: 0 });
    } } });
    const showing = dialogs.showCode({ parentWindow: window, code: '23456789AB' });
    assert(dialogs.showNotice({ parentWindow: window, kind: 'link-requested' }).ok, 'pairing progress port remains accepted while the code sheet is busy');
    releaseCode({ response: 0 }); await showing;
    await new Promise(resolve => setImmediate(resolve));
    assert(specs.length === 1 && specs[0].title === 'ChatGPT pairing code', 'closing the code sheet must not reveal a queued informational popup');
  },
}, {
  name: 'handoff bridge: privacy: routine pairing progress never opens a native sheet',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const specs = [];
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 0 }; } } });
    assert(dialogs.showNotice({ parentWindow: window, kind: 'link-requested' }).ok
      && dialogs.showNotice({ parentWindow: window, kind: 'linked' }).ok
      && dialogs.showNotice({ parentWindow: window, kind: 'pairing-closed' }).ok,
    'routine pairing state accepts the optional notice port without requesting a sheet');
    await new Promise(resolve => setImmediate(resolve));
    assert(specs.length === 0, 'linked and pairing-closed progress stays in the bridge UI, not native dialogs');
  },
}, {
  name: 'handoff bridge: privacy: pairing codes use fixed native-sheet controls and never persist in the dialog adapter',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const specs = []; const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 0 }; } } });
    const continued = await dialogs.showCode({ parentWindow: window, code: '23456789AB' });
    assert(specs.length === 1 && specs[0].message === 'Pairing code: 23456-789AB' && JSON.stringify(specs[0].buttons) === JSON.stringify(['Continue in setup', 'Cancel pairing']), 'the native pairing sheet receives the formatted XXXXX-XXXXX code with its fixed continue-or-cancel controls');
    assert(continued.keepOpen === true, 'the native primary action is the sole trusted signal that setup may retain pairing');
    assert(!JSON.stringify(dialogs).includes('23456789AB'), 'dialog API never retains the raw pairing code');
    const cancelled = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async () => ({ response: 1 }) } });
    assert((await cancelled.showCode({ parentWindow: window, code: '23456789AB' })).keepOpen === false, 'the native Cancel pairing response is never treated as a keep-open signal');
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
  name: 'handoff bridge: privacy: the restart sheet names the configured plugin only when the main-owned name is valid, else the neutral fallback',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const hostile = sentinel('plugin-name');
    const detailFor = async pluginName => {
      const specs = [];
      await createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 1 }; } } })
        .ask(sender, 'restart', { releasedCount: 1, items: [], pluginName });
      return specs[0].detail;
    };
    assert((await detailFor('my_plugin')).includes('Next: paste it into a new ChatGPT chat with my_plugin selected.'), 'a valid configured name is shown');
    for (const bad of [undefined, null, '', 5, `bad name ${hostile}`, `${hostile}\n`]) {
      const detail = await detailFor(bad);
      assert(detail.includes('with the Infinite Canvas plugin selected.') && !detail.includes(hostile), `an invalid or missing name falls back and is never echoed: ${JSON.stringify(bad)}`);
    }
  },
}, {
  name: 'handoff bridge: privacy: every remaining native confirmation is parented and renderer/client sentinels never reach it',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const hostile = sentinel('all-dialog-kinds'); const specs = [];
    const make = () => createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (parent, spec) => { assert(parent === window, 'every native sheet must receive the canvas parent'); specs.push(spec); return { response: 1 }; } } });
    const values = [
      ['enable', { hostname: 'bridge.example.com', idlePauseMinutes: 60, long: true, client_name: hostile }],
      ['disable', { client_name: hostile }],
      ['linkBreak', { hostname: 'bridge.example.com', redirect: hostile }],
      ['restart', { releasedCount: 1, items: [{ title: 'Disk title', company: 'Disk company' }], client_name: hostile }],
      ['resume', { reason: 'anomaly', count: 5, minutes: 10, at: 1, client_name: hostile }],
      ['release', { hostname: 'bridge.example.com', canvasFilePath: '/tmp/Disk.canvas', items: [{ title: 'Disk title', company: 'Disk company' }], label: hostile }],
      ['releasePush', { client_name: hostile }], ['scoring', { client_name: hostile }], ['autoStart', { client_name: hostile }], ['autoRelease', { client_name: hostile }],
      ['sourcePolicy', { client_name: hostile }], ['networkCheck', { client_name: hostile }], ['limits', { client_name: hostile }], ['forget', { client_name: hostile }],
      ['binaryApproval', { sourcePath: hostile, version: hostile, sha256: hostile, signature: hostile }],
    ];
    for (const [kind, details] of values) await make().ask(sender, kind, details);
    for (const [kind, details] of [
      ['hostname', { hostname: 'bridge.example.com' }],
      ['pairing', {}],
      ['revoke', {}],
      ['enable', { long: false }],
    ]) assert((await make().ask(sender, kind, details)).code === 'INVALID', `${kind} must not restore a routine native confirmation`);
    const serialized = JSON.stringify(specs);
    assert(!serialized.includes(hostile) && !serialized.includes('client_name') && !serialized.includes('redirect'), 'native dialog text cannot serialize renderer, remote-client, or redirect values');
    assert(specs.filter(spec => spec.message === 'Allow ChatGPT to fetch released handoffs?').length === 1, 'only the long critical enable consent may reach a native sheet');
    const longEnable = specs.find(spec => spec.title === 'Turn on ChatGPT bridge' && spec.detail.includes('bridge.example.com'));
    for (const disclosure of [
      'Only ChatGPT chats you start', 'Job listings, your career data, and drafts', 'Cloudflare and ChatGPT can read this data',
      'ChatGPT stores the chat', 'Pause or Revoke anytime', 'Quitting ends active chats',
      'After a restart, confirm released jobs again', 'After 1 hour without action, serving pauses until Resume; the tunnel and link stay up',
    ]) assert(longEnable?.detail.includes(disclosure), `long enable consent retains: ${disclosure}`);
    assert(!longEnable?.detail.includes('Delete the chat when done.') && !longEnable?.detail.includes('Copy/paste still works.'), 'long enable consent excludes noncritical follow-up advice');
    assert(longEnable.detail.trim().split(/\s+/).length <= 70, 'long enable consent must stay under the native-sheet readability budget');
    const buttonsFor = title => specs.find(spec => spec.title === title)?.buttons;
    for (const [title, label] of [
      ['Turn off ChatGPT bridge', 'Turn off'], ['Change bridge address', 'Change address'], ['Copy a starter for a new ChatGPT chat', 'Copy starter'],
      ['Resume bridge serving', 'Resume'], ['Release work to ChatGPT', 'Release'], ['Release scoring work', 'Release'], ['Forget bridge setup', 'Forget setup'],
    ]) assert(JSON.stringify(buttonsFor(title)) === JSON.stringify(['Cancel', label]), `${title} uses its specific affirmative label with Cancel as the safe default`);
    const releaseSpec = specs.find(spec => spec.title === 'Release work to ChatGPT');
    for (const disclosure of ['1 released job:', 'Disk title — Disk company', 'Canvas: Disk.canvas', 'Destination: bridge.example.com', 'career data, job listings, and drafts through Cloudflare']) assert(releaseSpec?.detail.includes(disclosure), `release consent retains: ${disclosure}`);
    const restartSpec = specs.find(spec => spec.title === 'Copy a starter for a new ChatGPT chat');
    for (const disclosure of ['1 released job will be available to the new chat', 'Disk title — Disk company', 'Chats from before the restart have ended', 'Next: paste it into a new ChatGPT chat with the Infinite Canvas plugin selected.']) assert(restartSpec?.detail.includes(disclosure), `restart consent retains: ${disclosure}`);
    const linkBreakSpec = specs.find(spec => spec.title === 'Change bridge address');
    assert(linkBreakSpec?.detail.includes('bridge.example.com') && linkBreakSpec.detail.includes('breaks the current ChatGPT link'), 'linked address consent must name the new host and reconnection consequence');
    const forgetSpec = specs.find(spec => spec.title === 'Forget bridge setup');
    assert(forgetSpec?.detail.includes('revokes ChatGPT access') && forgetSpec.detail.includes('Cloudflare tunnel') && forgetSpec.detail.includes('ChatGPT plugin') && forgetSpec.detail.includes('history are not deleted'), 'forget consent must state its local, access and external-data scope');
  },
}, {
  name: 'handoff bridge: privacy: long consent describes the exact configured idle-pause duration',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false };
    const cases = [
      [0, null],
      [30, 'After 30 minutes without action'],
      [90, 'After 1 hour 30 minutes without action'],
      [1440, 'After 1 day without action'],
      [1500, 'After 1 day 1 hour without action'],
      [2881, 'After 2 days 1 minute without action'],
    ];
    for (const [idlePauseMinutes, expected] of cases) {
      let spec;
      const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, value) => { spec = value; return { response: 0 }; } } });
      await dialogs.ask(sender, 'enable', { hostname: 'bridge.example.com', idlePauseMinutes, long: true });
      if (expected) assert(spec.detail.includes(expected), `idle pause ${idlePauseMinutes} must be stated exactly`);
      else assert(!spec.detail.includes('without action'), 'disabled idle pause must not claim that a timer is active');
    }
  },
}, {
  name: 'handoff bridge: privacy: pairing and binary sheets use the fixed restricted controls and copy',
  async run() {
    const sender = { id: 1, __isCanvasRenderer: true }; const window = { webContents: sender, isDestroyed: () => false }; const specs = [];
    const dialogs = createHandoffBridgeDialogs({ getCanvasWindows: () => [window], dialog: { showMessageBox: async (_parent, spec) => { specs.push(spec); return { response: 0 }; } } });
    await dialogs.showCode({ parentWindow: window, code: '23456789AB', expiresAt: 1 });
    await dialogs.ask(sender, 'binaryApproval', { sourcePath: '/tmp/cloudflared', version: '2026.9.3', size: 123, sha256: 'a'.repeat(64), signature: 'ad-hoc signed' });
    assert(JSON.stringify(specs[0].buttons) === JSON.stringify(['Continue in setup', 'Cancel pairing']) && specs[0].defaultId === 0 && specs[0].cancelId === 1 && specs[0].message.includes('Pairing code: 23456-789AB') && specs[0].detail.includes('Expires at') && specs[0].detail.includes('Only approve if you just started linking from ChatGPT.') && specs[0].detail.includes('Never share this code.'), 'pairing sheet has only the fixed continue-or-cancel controls, code, expiry and warnings');
    for (const detail of ['Source: /tmp/cloudflared', 'Version: 2026.9.3', 'Size: 123 bytes', 'SHA-256: aaaaaaaaaaaa', 'Signature: ad-hoc signed', 'This pin detects that the file changed; it cannot prove the file is genuine cloudflared: the Homebrew build is ad-hoc signed with no Team ID']) assert(specs[1].detail.includes(detail), `binary approval retains: ${detail}`);
    assert(JSON.stringify(specs[1].buttons) === JSON.stringify(['Cancel', 'Approve']), 'binary approval keeps its fixed safe buttons');
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
  name: 'handoff bridge: privacy: B8 report-host redaction follows persisted config through save, lifecycle, and forget',
  async run() {
    // Use an isolated bridge module instance: this test deliberately exercises
    // module-owned lifecycle state, while the report helper remains the real
    // process-wide bug-report sink.
    const bridge = await import(new URL(`../../electron/ipc/handoffBridge/index.js?b8-redaction-lifecycle=${process.pid}-${Date.now()}`, import.meta.url).href);
    const originalUserData = '/tmp/b8-redaction-original';
    const unreadableUserData = '/tmp/b8-redaction-unreadable';
    const originalHostname = 'b-0123456789abcdef0123.example.com';
    const replacementHostname = 'b-fedcba98765432100123.example.com';
    let persisted = { state: 'ok', config: { hostname: originalHostname } };
    const setup = { binaryPath: '/tmp/b8-redaction/bin/cloudflared', binaryTrusted: true, credentialsPath: '/tmp/b8-redaction/credentials/tunnel.json' };
    const readConfig = userData => userData === unreadableUserData ? { state: 'unreadable' } : persisted;
    const reportFor = hostname => redactReportUrl(`https://${hostname}/mcp?access=ignored`);
    const assertRedacted = hostname => assert(reportFor(hostname) === 'https://<bridge-host>/mcp', `${hostname} must be redacted`);
    const assertVisible = hostname => assert(reportFor(hostname) === `https://${hostname}/mcp`, `${hostname} must not remain redacted`);
    const canvas = { isDestroyed: () => false, webContents: { id: 804, __isCanvasRenderer: true, send() {} } };
    const ipc = fakeIpc();
    ipc.__getInvokeHandler = channel => ipc.handlers.get(channel);
    const lifecycleDeps = {
      env: {}, isPackaged: true, enabled: true, userData: originalUserData, tunnelState: setup, readConfig,
      compose: () => ({
        controller: {
          snapshot: () => ({ enabled: true, serving: 'live', config: { hostname: persisted.config.hostname, scope: { applications: true, scoring: false } }, limits: {}, prefs: {}, autoRelease: false, setup: { tunnelReachable: true } }),
          subscribe: () => () => undefined,
          disable: async () => ({ success: true }),
          forget: async () => ({ success: true }),
        },
        listener: {}, tunnel: {}, power: {}, tray: {},
      }),
    };
    try {
      await bridge.startHandoffBridge({ deps: lifecycleDeps });
      assertRedacted(originalHostname);

      assert(bridge.registerHandoffBridgeHandlers({ ipcMain: ipc, deps: {
        ...lifecycleDeps, getCanvasWindows: () => [canvas], dialogs: { ask: async () => ({ ok: true }) },
        writeConfig: async (_userData, patch) => {
          persisted = { state: 'ok', config: { ...persisted.config, ...patch } };
          return { ok: true, config: persisted.config };
        },
        forgetConfig: async () => true,
      } }), 'the isolated lifecycle must register its fake IPC ports');
      const event = { sender: canvas.webContents };
      const saved = await ipc.handlers.get(IPC_CHANNELS.SAVE_CONFIG)(event, { patch: { hostname: replacementHostname } });
      assert(saved.success, 'an acknowledged hostname save must succeed');
      assertRedacted(replacementHostname);
      assertVisible(originalHostname);

      const disabled = await ipc.handlers.get(IPC_CHANNELS.SET_ENABLED)(event, { enabled: false });
      assert(disabled.success, 'Disable must acknowledge the detached lifecycle');
      assertRedacted(replacementHostname);

      const unreadable = await bridge.startHandoffBridge({ deps: { ...lifecycleDeps, userData: unreadableUserData } });
      assert(unreadable.code === 'state_unreadable', 'the unreadable user-data root must fail closed');
      assertVisible(replacementHostname);

      await bridge.startHandoffBridge({ deps: lifecycleDeps });
      assertRedacted(replacementHostname);

      const forgotten = await ipc.handlers.get(IPC_CHANNELS.FORGET_SETUP)(event);
      assert(forgotten.success, 'Forget must acknowledge its durable wipe');
      assertVisible(replacementHostname);

      ipc.handlers.clear();
      assert(bridge.registerHandoffBridgeHandlers({ ipcMain: ipc, deps: { ...lifecycleDeps, getCanvasWindows: () => [canvas], dialogs: { ask: async () => ({ ok: true }) }, forgetConfig: async () => true } }), 'cleared fake IPC handlers must permit same-userData registration');
      await ipc.handlers.get(IPC_CHANNELS.GET_STATUS)(event);
      assertVisible(replacementHostname);
    } finally {
      setReportRedactedHosts([]);
      await bridge.stopHandoffBridge();
    }
  },
}, {
  name: 'handoff bridge: privacy: configured bridge hostnames are redacted from a generated report without changing look-alikes',
  run: () => {
    const hostname = 'b-0123456789abcdef0123.lullascape.com';
    const report = [
      `Origin: https://${hostname}/mcp?access=${sentinel('report-token')}#fragment`,
      `Mentioned again: ${hostname}.`,
      `A longer hostname is not the bridge: api.${hostname}.`,
      `An identifier is not the bridge: x${hostname}.`,
    ].join('\n');
    try {
      setReportRedactedHosts([hostname]);
      const url = redactReportUrl(`https://${hostname}/mcp?access=${sentinel('report-url-token')}`);
      const redacted = redactReportUrlsInText(report);
      const exactHost = new RegExp(`(^|[^a-z0-9_.-])${hostname.replace(/\./g, '\\.')}(?=$|[^a-z0-9_.-])`, 'i');
      assert(url === 'https://<bridge-host>/mcp', 'configured bridge URL origin must be replaced before query data is reported');
      assert(redacted.includes('<bridge-host>') && !exactHost.test(redacted), 'a generated report must contain the bridge placeholder and never the configured hostname');
      assert(redacted.includes(`api.${hostname}`) && redacted.includes(`x${hostname}`), 'hostname redaction must not erase a longer hostname or an identifier that only contains it');
    } finally {
      setReportRedactedHosts([]);
    }
  },
}, {
  name: 'handoff bridge: privacy: bug-report URL helpers remain byte-identical before bridge redaction is configured',
  run: () => {
    // These are captured outputs from the pre-bridge helper implementation,
    // not values recomputed from the functions under test.  A future default
    // redaction therefore cannot silently redefine this compatibility check.
    const url = 'https://example.com/path/to/report?access=ignored#ignored';
    const prose = 'See https://example.com/path/to/report?access=ignored#ignored, then https://other.example.com/next?x=1.';
    try {
      setReportRedactedHosts([]);
      assert(redactReportUrl(url) === 'https://example.com/path/to/report', 'unset hostname redaction must preserve the historical URL helper bytes');
      assert(redactReportUrlsInText(prose) === 'See https://example.com/path/to/report, then https://other.example.com/next.', 'unset hostname redaction must preserve the historical prose helper bytes');
    } finally {
      setReportRedactedHosts([]);
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
}, {
  name: 'handoff bridge: privacy: a re-copied starter key stays out of logs, the security ledger, status and the bug report, and is dropped at the first call',
  async run() {
    const base = { description: 'Copy starter pressed repeatedly.', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [] };
    const audit = []; const lines = []; let counter = 0;
    const jobId = '11111111-1111-4111-8111-111111111111';
    const application = {
      read: async () => ({ kind: 'open', handoff: { code: 'HANDOFF-A', jobId, stage: 'resume', revision: 1, prompt: 'Synthetic prompt.' } }),
      status: async () => ({ kind: 'host' }), submit: async () => ({ kind: 'accepted', completed: true }),
    };
    const logger = createHandoffBridgeLog({ logger: { info: line => lines.push(line) }, now: () => 5 });
    const engine = createHandoffEngine({
      source: application, holdMs: 0, random: () => Buffer.alloc(26, (counter += 1)), logger,
      audit: { append: (event, fields) => { audit.push({ event, fields }); return Promise.resolve(true); } },
    });
    try {
      assert((await engine.release({ jobs: [{ jobId, canvasFilePath: '/tmp/privacy.canvas' }] })).ok, 'fixture job releases');
      const presses = [];
      for (let index = 0; index < 4; index += 1) { const prepared = await engine.prepareChat({ linkId: 'link-privacy', kind: 'new' }); prepared.commit(); presses.push(prepared); }
      const key = presses[0].sessionCode;
      assert(presses.every(item => item.sessionCode === key && item.chatOrdinal === 1) && presses.slice(1).every(item => item.recopied === true), 'four presses are one starter for chat 1');
      setBridgeQueueDiagnosticProvider(() => ({ ...engine.snapshot(), enabled: true, serving: 'live' }));
      const observed = () => JSON.stringify({ lines, audit, status: engine.snapshot(), activity: logger.getRecent(), report: generateMarkdown({ ...base, filterCode: 'FULL' }).markdown });
      const beforeCall = observed();
      assert(lines.filter(line => line === '[HandoffBridge] starter_recopied chatOrdinal=1').length === 3, 'the closed re-copy line is logged for each re-copy');
      assert(!beforeCall.includes(key) && !beforeCall.includes(key.toLowerCase()), 'no re-copy sink carries the plaintext starter key');
      assert(audit.every(entry => entry.event !== 'starter_recopied') && audit.filter(entry => entry.event === 'new_chat').length === 1, 'a re-copy never reaches the security ledger');
      assert((await engine.get({ session: key, linkId: 'link-privacy' })).status === 'served', 'the re-copied key works for its first call');
      const next = await engine.prepareChat({ linkId: 'link-privacy', kind: 'new' });
      assert(next.recopied !== true && next.sessionCode !== key && next.chatOrdinal === 2, 'once called, the plaintext is gone and a press mints a new chat');
      next.commit();
      const afterCall = observed();
      assert(!afterCall.includes(key) && !afterCall.includes(next.sessionCode), 'rotation and retirement leave no key text anywhere observable');
    } finally { clearBridgeQueueDiagnostic(); await engine.close(); }
  },
}, {
  name: 'handoff bridge: privacy: a key that was presented and turned away, or unrecognised keys, leave no key text in status, logs, ledger or the report, and the report counts the unrecognised ones',
  async run() {
    const base = { description: 'Wrong keys and a refused chat.', nodes: [], edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [], eventLogs: [] };
    const audit = []; const lines = []; let counter = 0; let stamp = 1_700_000_000_000;
    const application = { read: async () => ({ kind: 'host' }), status: async () => ({ kind: 'host' }), submit: async () => ({ kind: 'accepted', completed: true }) };
    const logger = createHandoffBridgeLog({ logger: { info: line => lines.push(line) }, now: () => 5 });
    const engine = createHandoffEngine({
      source: application, holdMs: 0, now: () => stamp, random: () => Buffer.alloc(26, (counter += 1)), logger, limits: { idlePauseMinutes: 60 },
      audit: { append: (event, fields) => { audit.push({ event, fields }); return Promise.resolve(true); } },
    });
    try {
      const wrong = 'WRONG-KEY-SENTINEL-' + sentinel('wrong');
      const first = await engine.prepareChat({ linkId: 'link-privacy', kind: 'new' }); first.commit();
      stamp += 2 * 3_600_000;
      assert((await engine.get({ session: first.sessionCode, linkId: 'link-privacy' })).status === 'paused', 'the idle pause turns the valid key away');
      const next = await engine.prepareChat({ linkId: 'link-privacy', kind: 'new' }); next.commit();
      for (let index = 0; index < 20; index += 1) await engine.get({ session: wrong, linkId: 'link-privacy' });
      assert((await engine.get({ session: first.sessionCode, linkId: 'link-privacy' })).status === 'session_ended', 'the retired key reads as ended');
      setBridgeQueueDiagnosticProvider(() => ({ ...engine.snapshot(), enabled: true, serving: 'live' }));
      const report = generateMarkdown({ ...base, filterCode: 'FULL' }).markdown;
      const observed = JSON.stringify({ lines, audit, status: engine.snapshot(), activity: logger.getRecent(), report });
      for (const secret of [first.sessionCode, next.sessionCode, wrong]) assert(!observed.includes(secret) && !observed.includes(secret.toLowerCase()), 'no presented, current or wrong key text appears in any sink');
      assert(engine.snapshot().paused === false && engine.snapshot().pauseCause === null, 'unrecognised keys did not pause the engine');
      const iso = new Date(stamp).toISOString();
      assert(report.includes(`- Unrecognised chat keys: 20 in the last 10 min (last at ${iso})`), `the report states the count and time as an observation: ${report.split('\n').filter(line => /chat keys/i.test(line)).join(' | ')}`);
      assert(report.includes('- Ended-chat keys: 1'), 'the report states the ended-chat key count');
      assert(!/Unrecognised chat keys[^\n]*(attack|because|caused|stale chat)/i.test(report), 'the line states observations only, never a cause');
    } finally { clearBridgeQueueDiagnostic(); await engine.close(); }
  },
}, {
  name: 'handoff bridge: privacy: the persisted ended-chat file never contains a plaintext chat key, a link id, or the in-memory epoch hash',
  async run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-handoff-privacy-ledger-'));
    let counter = 0;
    const application = { read: async () => ({ kind: 'host' }), status: async () => ({ kind: 'host' }), submit: async () => ({ kind: 'accepted', completed: true }) };
    const store = createLaneStore({ userDataPath: dir });
    const engine = createHandoffEngine({ source: application, store, holdMs: 0, random: () => Buffer.alloc(26, (counter += 1)) });
    try {
      const linkId = 'link-ledger-' + sentinel('link');
      const codes = [];
      for (let index = 0; index < 3; index += 1) {
        const prepared = await engine.prepareChat({ linkId, kind: 'new' }); prepared.commit(); codes.push(prepared.sessionCode);
        await engine.get({ session: prepared.sessionCode, linkId });
      }
      await store.flush();
      const text = fs.readFileSync(store.retiredPath, 'utf8');
      const parsed = JSON.parse(text);
      assert(parsed.chats.length === 3, 'three chats are on record');
      for (const secret of [...codes, linkId]) assert(!text.includes(secret) && !text.toLowerCase().includes(secret.toLowerCase()), 'the file holds neither a chat key nor the link id');
      assert(parsed.v === 2 && parsed.chats.every(chat => Object.keys(chat).sort().join() === 'digest,retiredAt' && /^[a-f0-9]{64}$/.test(chat.digest)), 'entries are digests only, with no link digest field');
      // The file digest is under its own domain prefix, so it is not the epoch hash.
      const epochHash = crypto.createHash('sha256').update(`epoch\n${linkId}\n${codes[0]}`).digest('hex');
      assert(!text.includes(epochHash), 'the in-memory epoch hash is not what is written');
      // It is link-free: exactly sha256 over the v2 prefix and the key, and no digest of the link id is written either.
      const sha = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
      assert(codes.every(code => parsed.chats.some(chat => chat.digest === sha(`retired-chat-v2\n${code}`))), 'each digest is the link-free digest of its key');
      for (const linkDigest of [sha(`retired-chat-link-v1\n${linkId}`), sha(`epoch-link\n${linkId}`), sha(`retired-chat-v1\n${linkId}\n${codes[0]}`)]) assert(!text.includes(linkDigest), 'no link-bound or link-only digest is written');
      // A live chat that is relinked away is retired as ended and leaves nothing but its link-free digest.
      const relinked = await engine.prepareChat({ linkId: linkId + '-b', kind: 'new' }); relinked.commit();
      assert(engine.noteLink(linkId + '-c') === true, 'a relink retires the live chat');
      await store.flush();
      const after = fs.readFileSync(store.retiredPath, 'utf8');
      assert(JSON.parse(after).chats.length === 4 && !after.includes(relinked.sessionCode) && !after.includes(linkId), 'the relink adds only a digest');
      assert(fs.readdirSync(path.dirname(store.retiredPath)).every(name => !name.endsWith('.tmp')), 'no temporary file is left behind');
    } finally { await engine.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  },
}];
