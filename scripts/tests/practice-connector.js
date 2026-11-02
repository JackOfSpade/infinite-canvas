import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  PRACTICE_MCP_PATH, getPracticeConnectorStatus, readPracticeHostname, startPracticeConnector, stopPracticeConnector,
} from '../../electron/ipc/practiceConnector/index.js';

const HOST = 'practice.example.com';
const connectorDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'electron', 'ipc', 'practiceConnector');

async function withUserData(run, { config } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-practice-connector-'));
  try {
    await fs.promises.mkdir(path.join(dir, 'handoff-bridge'), { recursive: true });
    if (config !== undefined) await fs.promises.writeFile(path.join(dir, 'handoff-bridge', 'config.json'), config);
    await run(dir);
  } finally {
    await stopPracticeConnector();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function fakes({ supervisorState = 'online', startResult = { ok: true } } = {}) {
  const calls = { listeners: [], supervisors: [], reaps: [], order: [] };
  const createListener = options => {
    const listener = { options, start: async () => { calls.order.push('listener.start'); return { path: options.socketPath }; }, stop: async () => { calls.order.push('listener.stop'); } };
    calls.listeners.push(listener);
    return listener;
  };
  const state = { value: supervisorState };
  const createTunnelSupervisor = options => {
    const supervisor = {
      options,
      start: async () => { calls.order.push('supervisor.start'); return startResult; },
      stop: async () => { calls.order.push('supervisor.stop'); return { ok: true }; },
      status: () => ({ state: state.value }),
    };
    calls.supervisors.push(supervisor);
    return supervisor;
  };
  const reapOrphans = async options => { calls.reaps.push(options); return { ok: true }; };
  return { calls, state, deps: { createListener, createTunnelSupervisor, reapOrphans } };
}

function fakeRequest({ url = PRACTICE_MCP_PATH, method = 'POST', host = HOST, body = '' } = {}) {
  const req = new EventEmitter();
  Object.assign(req, { url, method, headers: { host, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, socket: { remoteAddress: '203.0.113.9' }, destroy() {} });
  const res = { status: 0, body: '', headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(data) { this.body = String(data || ''); } };
  return { req, res };
}

async function dispatch(handler, options) {
  const { req, res } = fakeRequest(options);
  const done = handler(req, res);
  req.emit('data', Buffer.from(options?.body || ''));
  req.emit('end');
  await done;
  return res;
}

const tunnelState = { v: 1, credentialsPath: '/unused/creds.json', binaryPath: '/unused/cloudflared', pin: 'a'.repeat(64), approvedAt: 1, binaryTrusted: true };
const configWith = hostname => JSON.stringify({ hostname, enabled: true, somethingElse: { nested: true } });

export default [
  { name: 'practice connector: hostname is read from config.json, tolerating other fields, a missing file and bad JSON', async run() {
    await withUserData(async dir => {
      assert.equal(readPracticeHostname(dir), HOST);
    }, { config: configWith(HOST) });
    await withUserData(async dir => assert.equal(readPracticeHostname(dir), null), {});
    await withUserData(async dir => assert.equal(readPracticeHostname(dir), null), { config: '{ not json' });
    await withUserData(async dir => assert.equal(readPracticeHostname(dir), null), { config: '[]' });
    await withUserData(async dir => assert.equal(readPracticeHostname(dir), null), { config: JSON.stringify({ hostname: 42 }) });
    await withUserData(async dir => assert.equal(readPracticeHostname(dir), null), { config: JSON.stringify({ hostname: '' }) });
    assert.equal(readPracticeHostname(undefined), null);
  } },
  { name: 'practice connector: unset, missing or corrupt setup leaves status off, starts nothing and never throws', async run() {
    const cases = [
      { label: 'no config file', config: undefined, tunnel: tunnelState },
      { label: 'bad JSON config', config: '{ not json', tunnel: tunnelState },
      { label: 'config without hostname', config: JSON.stringify({ enabled: true }), tunnel: tunnelState },
      { label: 'no tunnel state', config: configWith(HOST), tunnel: null },
    ];
    for (const item of cases) {
      await withUserData(async dir => {
        const { calls, deps } = fakes();
        const status = await startPracticeConnector({ userData: dir, ...deps, readTunnelState: () => item.tunnel });
        assert.equal(status.serving, 'off', item.label);
        assert.deepEqual(getPracticeConnectorStatus(), { hostname: null, serving: 'off' }, item.label);
        assert.equal(calls.listeners.length, 0, `${item.label}: no listener`);
        assert.equal(calls.supervisors.length, 0, `${item.label}: no supervisor`);
        assert.equal(calls.reaps.length, 0, `${item.label}: nothing reaped`);
      }, { config: item.config });
    }
    await withUserData(async dir => {
      const { calls, deps } = fakes();
      const status = await startPracticeConnector({ userData: dir, ...deps, readTunnelState: () => { throw new Error('corrupt'); } });
      assert.equal(status.serving, 'off');
      assert.equal(calls.listeners.length, 0);
    }, { config: configWith(HOST) });
    assert.equal((await startPracticeConnector({})).serving, 'off', 'no userData at all');
    assert.deepEqual(getPracticeConnectorStatus(), { hostname: null, serving: 'off' });
  } },
  { name: 'practice connector: with setup it starts one listener and one supervisor and routes practice requests, 404 for the rest', async run() {
    await withUserData(async dir => {
      const { calls, state, deps } = fakes({ supervisorState: 'connecting' });
      const seen = [];
      const mcp = async body => { seen.push(body); return { status: 200, body: { jsonrpc: '2.0', id: body.id, result: { routed: true } } }; };
      const status = await startPracticeConnector({ userData: dir, ...deps, mcp, readTunnelState: () => tunnelState });
      assert.deepEqual(status, { hostname: HOST, serving: 'starting' });
      assert.equal(calls.listeners.length, 1);
      assert.equal(calls.supervisors.length, 1);
      assert.deepEqual(calls.order, ['listener.start', 'supervisor.start']);
      assert.equal(calls.reaps.length, 1);
      assert.equal(calls.reaps[0].userData, dir);
      assert.equal(calls.reaps[0].configPath, path.join(dir, 'handoff-bridge', 'tunnel', 'config.yml'));
      const listenerOptions = calls.listeners[0].options;
      assert.equal(listenerOptions.socketPath, path.join(dir, 'handoff-bridge', 'b.sock'));
      const supervisorOptions = calls.supervisors[0].options;
      assert.equal(supervisorOptions.hostname, HOST);
      assert.equal(supervisorOptions.socketPath, listenerOptions.socketPath);
      assert.equal(supervisorOptions.credentialsPath, tunnelState.credentialsPath);
      assert.equal(supervisorOptions.pin, tunnelState.pin);
      state.value = 'online';
      assert.deepEqual(getPracticeConnectorStatus(), { hostname: HOST, serving: 'live' });
      state.value = 'failed';
      assert.equal(getPracticeConnectorStatus().serving, 'failed');
      state.value = 'online';

      const handler = listenerOptions.handler;
      const practice = await dispatch(handler, { body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) });
      assert.equal(practice.status, 200);
      assert.deepEqual(JSON.parse(practice.body), { jsonrpc: '2.0', id: 7, result: { routed: true } });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].method, 'ping');

      for (const url of ['/mcp', '/.well-known/oauth-protected-resource/mcp', '/', '/practice', '/practice/mcp/extra']) {
        const other = await dispatch(handler, { url, body: '{}' });
        assert.equal(other.status, 404, `${url} is not a practice request`);
      }
      assert.equal(seen.length, 1, '404 paths never reach the practice connector');

      const wrongHost = await dispatch(handler, { host: 'evil.example.net', body: '{}' });
      assert.equal(wrongHost.status, 421);
      const wrongMethod = await dispatch(handler, { method: 'GET' });
      assert.equal(wrongMethod.status, 405);

      const { req: expectReq, res: expectRes } = fakeRequest({ url: '/mcp' });
      assert.equal(handler.preflight(expectReq, expectRes), false, 'a non-practice Expect request is refused');
      assert.equal(expectRes.status, 404);
      const { req: okReq, res: okRes } = fakeRequest();
      assert.equal(handler.preflight(okReq, okRes), true, 'a practice Expect request is admitted');
      assert.equal(okRes.status, 0);
    }, { config: configWith(HOST) });
  } },
  { name: 'practice connector: a supervisor that refuses to start reports failed, and starting twice does not duplicate', async run() {
    await withUserData(async dir => {
      const { calls, deps } = fakes({ startResult: { ok: false, code: 'credentials-invalid' } });
      const first = await startPracticeConnector({ userData: dir, ...deps, readTunnelState: () => tunnelState });
      assert.deepEqual(first, { hostname: HOST, serving: 'failed' });
      await startPracticeConnector({ userData: dir, ...deps, readTunnelState: () => tunnelState });
      assert.equal(calls.listeners.length, 1);
      assert.equal(calls.supervisors.length, 1);
    }, { config: configWith(HOST) });
    await withUserData(async dir => {
      const { calls, deps } = fakes();
      const failing = { ...deps, createListener: options => ({ options, start: async () => { throw Object.assign(new Error('in use'), { code: 'socket_unavailable' }); }, stop: async () => { calls.order.push('listener.stop'); } }) };
      const status = await startPracticeConnector({ userData: dir, ...failing, readTunnelState: () => tunnelState });
      assert.equal(status.serving, 'failed');
      assert.equal(calls.order.includes('supervisor.start'), false, 'no tunnel is started when the listener could not bind');
    }, { config: configWith(HOST) });
  } },
  { name: 'practice connector: stop closes the tunnel, then the listener, and returns to off', async run() {
    await withUserData(async dir => {
      const { calls, deps } = fakes();
      await startPracticeConnector({ userData: dir, ...deps, readTunnelState: () => tunnelState });
      assert.equal(getPracticeConnectorStatus().serving, 'live');
      const stopped = await stopPracticeConnector();
      assert.deepEqual(stopped, { hostname: null, serving: 'off' });
      assert.deepEqual(getPracticeConnectorStatus(), { hostname: null, serving: 'off' });
      assert.deepEqual(calls.order, ['listener.start', 'supervisor.start', 'supervisor.stop', 'listener.stop']);
      await stopPracticeConnector();
      assert.equal(calls.order.filter(step => step === 'listener.stop').length, 1, 'a second stop is a no-op');
      const again = await startPracticeConnector({ userData: dir, ...deps, readTunnelState: () => tunnelState });
      assert.equal(again.serving, 'live', 'it can be started again after a stop');
      assert.equal(calls.listeners.length, 2);
    }, { config: configWith(HOST) });
  } },
  { name: 'practice connector: nothing in practiceConnector/ imports from handoffBridge/', async run() {
    const files = [];
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(connectorDir);
    assert.ok(files.length >= 15, `the copied tunnel, listener and connector files are present (found ${files.length})`);
    const importPattern = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        assert.equal(/handoffBridge/i.test(match[1]), false, `${path.relative(connectorDir, file)} imports ${match[1]}`);
      }
    }
  } },
];
