import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { writeFakeCloudflaredLauncher } from './fixtures/handoff-bridge/bridgeFixtures.js';
import { createFakeProcessTable } from './fixtures/handoff-bridge/fakeProcessTable.js';
import { createFakeSpawn } from './fixtures/handoff-bridge/fakeSpawn.js';
import { WATCHDOG_SCRIPT } from '../../electron/ipc/handoffBridge/tunnel/constants.js';
import { buildChildEnv, buildDryRunArgv, buildRunArgv, renderTunnelConfig } from '../../electron/ipc/handoffBridge/tunnel/config.js';
import { classifyExit, classifyProbe } from '../../electron/ipc/handoffBridge/tunnel/classify.js';
import { parsePsRows, isOwnedTunnelRow } from '../../electron/ipc/handoffBridge/tunnel/psParse.js';
import { createLogRing } from '../../electron/ipc/handoffBridge/tunnel/logRing.js';
import { chooseMetricsPort } from '../../electron/ipc/handoffBridge/tunnel/probe.js';
import { validateCredentialsPath, validateTunnelConfig, validateTunnelId } from '../../electron/ipc/handoffBridge/tunnel/validate.js';
import { redactLine } from '../../electron/ipc/handoffBridge/tunnel/redact.js';
import { execBinary, spawnCloudflared } from '../../electron/ipc/handoffBridge/tunnel/exec.js';
import { reapOrphans } from '../../electron/ipc/handoffBridge/tunnel/reap.js';
import { createTunnelSupervisor } from '../../electron/ipc/handoffBridge/tunnel/supervisor.js';
import { createRealTunnelSupervisor } from '../../electron/ipc/handoffBridge/tunnel/index.js';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { validateDryRunOutput } from '../../electron/ipc/handoffBridge/tunnel/config.js';
import { publicProbe } from '../../electron/ipc/handoffBridge/tunnel/probe.js';
import { createRotatingLog } from '../../electron/ipc/handoffBridge/tunnel/logRing.js';
import { findApprovedCopy, findBinary, prepareBinary, verifyPinnedCopy } from '../../electron/ipc/handoffBridge/tunnel/binary.js';
import { ensureTunnelDirectory, readTunnelState, tunnelPaths, writeTunnelState } from '../../electron/ipc/handoffBridge/tunnel/files.js';
import { inspectCredentials, recordTunnelIntent } from '../../electron/ipc/handoffBridge/tunnel/credentials.js';
import { ensureDirectoryWithinRoot } from '../../electron/utils/pathSafety.js';

const fakeUrl = new URL('./fixtures/handoff-bridge/fake-cloudflared.js', import.meta.url);
const TUNNEL_ID = '123e4567-e89b-42d3-a456-426614174000';

function createMemoryBinaryFs() {
  const entries = new Map(); const fds = new Map(); let nextFd = 10;
  const add = (name, bytes, mode = 0o500, extra = {}) => entries.set(name, { bytes: Buffer.from(bytes), mode, uid: 501, file: true, ...extra });
  const statFor = name => {
    const value = entries.get(name);
    if (!value) throw new Error(`missing ${name}`);
    return { size: value.bytes?.length || 0, mode: value.mode, uid: value.uid, gid: value.gid, isFile: () => value.file === true, isDirectory: () => value.file !== true, isSymbolicLink: () => value.symlink === true };
  };
  return {
    add, entries,
    mkdirSync(name) { if (!entries.has(name)) entries.set(name, { mode: 0o700, uid: 501, file: false }); },
    statSync: statFor, lstatSync: statFor, realpathSync: Object.assign(name => entries.get(name)?.realpath || name, { native: name => entries.get(name)?.realpath || name }),
    existsSync: name => entries.has(name), chmodSync(name, mode) { entries.get(name).mode = mode; },
    openSync(name, flags) { if (flags === 'wx') { if (entries.has(name)) throw new Error('exists'); entries.set(name, { bytes: Buffer.alloc(0), mode: 0o500, uid: 501, file: true }); } const fd = nextFd++; fds.set(fd, { name, offset: 0 }); return fd; },
    fstatSync(fd) { return statFor(fds.get(fd).name); },
    readSync(fd, target, start, length) { const handle = fds.get(fd); const bytes = entries.get(handle.name).bytes; const count = Math.min(length, bytes.length - handle.offset); bytes.copy(target, start, handle.offset, handle.offset + count); handle.offset += count; return count; },
    writeSync(fd, source, start = 0, length = source.length) {
      const handle = fds.get(fd);
      const value = entries.get(handle.name);
      const bytes = Buffer.isBuffer(source) ? source : Buffer.from(String(source));
      const written = bytes.subarray(start, start + length);
      value.bytes = Buffer.concat([value.bytes, written]);
      return written.length;
    },
    writeFileSync(fd, value) { const bytes = Buffer.from(String(value)); const handle = fds.get(fd); entries.get(handle.name).bytes = bytes; },
    readFileSync(name, encoding) { const bytes = entries.get(name)?.bytes; if (!bytes) throw new Error(`missing ${name}`); return encoding ? bytes.toString(encoding) : Buffer.from(bytes); },
    fsyncSync() {}, closeSync(fd) { fds.delete(fd); }, renameSync(from, to) { const value = entries.get(from); if (!value) throw new Error('rename'); entries.set(to, value); entries.delete(from); }, unlinkSync(name) { entries.delete(name); },
  };
}

const flush = async (turns = 24) => { for (let index = 0; index < turns; index++) await Promise.resolve(); };

function createSupervisorHarness(overrides = {}) {
  const clock = overrides.clock || createFakeClock(0);
  const table = createFakeProcessTable({ parentPid: 500 });
  const fakeSpawn = createFakeSpawn({ processTable: table, pidStart: 2200 });
  const order = []; const audits = []; const alarms = []; let configText = '';
  const host = 'b-0123456789abcdef0123.lullascape.com';
  const userData = '/tmp/ic-supervisor-matrix';
  const options = {
    userData, hostname: host, socketPath: `${userData}/handoff-bridge/b.sock`, credentialsPath: `/tmp/${TUNNEL_ID}.json`, binaryPath: '/tmp/source-cloudflared', pin: 'f'.repeat(64), timers: clock, now: clock.now, random: () => 0.5,
    ensureTunnelDirectory: async () => { order.push('directory'); },
    reapOrphans: async () => { order.push('reap'); return { ok: true, notices: [] }; },
    inspectCredentials: () => { order.push('credentials'); return { ok: true, tunnelId: TUNNEL_ID, credentialsPath: `/tmp/${TUNNEL_ID}.json` }; },
    legacyCertPresent: () => false,
    prepareBinary: async () => { order.push('binary'); return { ok: true, copyPath: '/tmp/cloudflared-ffffffff', sha256: 'f'.repeat(64), version: '2026.9.3' }; },
    findBinary: () => '/tmp/source-cloudflared', chooseMetricsPort: () => 50000,
    atomicWriteText: (_target, text) => { order.push('config'); configText = text; }, readConfig: () => configText,
    dryRun: async (_binary, args) => { order.push(`dry:${args.at(-1)}`); return { ok: true, output: args.at(-1) === 'validate' ? `Validating rules from ${tunnelPaths(userData).config}\nOK` : args.at(-1).includes('not-the-bridge') ? 'rule #1 http_status:404' : `rule #0 https://${host}/mcp unix:${userData}/handoff-bridge/b.sock` }; },
    verifyPinnedCopy: () => { order.push('verify'); return { ok: true }; },
    recordTunnelIntent: (_root, data) => { order.push(data.pid === null ? 'intent:pre' : 'intent:live'); },
    spawnCloudflared: args => { order.push('spawn'); const child = spawnCloudflared({ ...args, spawnImpl: fakeSpawn }); if (typeof overrides.rawLine === 'string') args.onLine?.(overrides.rawLine); return child; },
    getProcessInfo: async pid => ({ pid, ppid: 500, pgid: pid, lstart: 'Mon Jan  1 00:00:00 2026', command: 'synthetic' }),
    probeReady: async () => ({ ok: true, state: 'ready' }), publicProbeFn: async () => ({ ok: true, code: 'ok' }),
    signalGroup: (pid, signal) => { order.push(`signal:${signal}`); const entry = fakeSpawn.calls.find(call => call.child.pid === pid); if (!entry) return false; if (signal === 'SIGKILL' || !overrides.ignoreTerm) entry.child.__exit(signal === 'SIGKILL' ? null : 0, signal); return true; },
    wait: async ms => { order.push(`wait:${ms}`); },
    audit: entry => audits.push(entry), alarm: code => alarms.push(code),
    ...overrides,
  };
  delete options.clock;
  delete options.ignoreTerm;
  const supervisor = createTunnelSupervisor(options);
  return { supervisor, clock, table, fakeSpawn, order, audits, alarms, options };
}

// Keep the B3 matrix split into individual runner cases: each row is a
// distinct invariant and stays entirely in process with injected/pure ports.
const B3_MATRIX = [
  ...['Upper.Example.com', 'a..b.com', '127.0.0.1', 'a.b', 'a.b.c.', 'xn--bad.b.c', 'a:b.c.d', 'a b.c.d', 'a.b.\u2603', 'a.{}.c', 'a.#.c', 'a.\n.c'].map(hostname => ({
    label: `rejects hostname ${JSON.stringify(hostname)}`,
    run: () => assert(!validateTunnelConfig({ tunnelId: TUNNEL_ID, hostname, credentialsPath: `/tmp/${TUNNEL_ID}.json`, socketPath: '/tmp/bridge/b.sock' }), 'invalid hostname accepted'),
  })),
  ...['relative/b.sock', '/tmp/../b.sock', '/tmp/a\n.sock', `/tmp/${'x'.repeat(110)}`, '/tmp/a:b.sock', '/tmp/a#b.sock', '/tmp/a"b.sock', '/tmp/a{b.sock'].map(socketPath => ({
    label: `rejects socket ${JSON.stringify(socketPath)}`,
    run: () => assert(!validateTunnelConfig({ tunnelId: TUNNEL_ID, hostname: 'a.b.c', credentialsPath: `/tmp/${TUNNEL_ID}.json`, socketPath }), 'invalid socket accepted'),
  })),
  ...[
    [{ status: 530 }, 'tunnel-not-serving'], [{ status: 502 }, 'origin-unreachable'], [{ status: 503 }, 'origin-unreachable'], [{ status: 504 }, 'origin-unreachable'], [{ status: 404 }, 'ingress-mismatch'], [{ status: 403, server: 'cloudflare' }, 'edge-blocked'], [{ status: 429, server: 'cloudflare' }, 'edge-blocked'], [{ status: 302 }, 'unexpected-redirect'], [{ status: 'ENOTFOUND' }, 'dns-not-found'], [{ online: false }, 'offline'], [{ publicAddress: false }, 'hostname-not-public']
  ].map(([input, expected]) => ({ label: `classifies probe ${expected}`, run: () => assert(classifyProbe(input) === expected, 'wrong probe classification') })),
  ...[
    [{ code: 0, requested: true }, 'exited'], [{ code: 1, requested: true }, 'exited-early'], [{ signal: 'SIGTERM', requested: true }, 'exited-early'], [{ code: 1, lines: ['network is unreachable'] }, 'network-unreachable'], [{ code: 1, lines: ['address already in use'] }, 'metrics-port-in-use'], [{ code: 1, lines: ['credentials invalid'] }, 'credentials-invalid'], [{ code: 1, lines: ['tunnel authentication rejected'] }, 'tunnel-auth-rejected']
  ].map(([input, expected]) => ({ label: `classifies exit ${expected}`, run: () => assert(classifyExit(input) === expected, 'wrong exit classification') })),
  ...[0, 0.01, 0.25, 0.5, 0.75, 0.9999].map(value => ({ label: `draws metrics port for random ${value}`, run: () => { const port = chooseMetricsPort({ random: () => value }); assert(port >= 49152 && port <= 65535, 'port outside permitted range'); } })),
  ...['config.yml.bak', '/other/config.yml', '/cloudflared', 'cloudflared-deadbeefx'].map(suffix => ({ label: 'rejects ps ownership near-miss', run: () => { const configPath = '/tmp/ic/handoff-bridge/tunnel/config.yml'; const row = { command: `/tmp/ic/handoff-bridge/tunnel/bin/${suffix} tunnel --config ${configPath} --no-autoupdate run x` }; assert(!isOwnedTunnelRow(row, { configPath, userData: '/tmp/ic' }), 'near-miss ps row accepted'); } })),
].map(({ label, run }, index) => ({ name: `handoff bridge: tunnel: B3 matrix ${String(index + 1).padStart(2, '0')} ${label}`, run }));

export default [
  {
    name: 'handoff bridge: tunnel: injected spawn and process table model lifecycle without a child process',
    async run() {
      const table = createFakeProcessTable({ parentPid: 1000 });
      const spawn = createFakeSpawn({ processTable: table, pidStart: 2000 });
      const child = spawn('/synthetic/cloudflared', ['tunnel', '--loglevel', 'info'], { shell: false, detached: true });
      await Promise.resolve();
      assert(spawn.calls.length === 1 && spawn.last().command === '/synthetic/cloudflared', 'fake spawn must record one absolute executable');
      assert(spawn.last().options.shell === false && table.isAlive(child.pid), 'the fake child must begin alive with shell disabled');
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.__writeStderr('synthetic line');
      assert(stderr === 'synthetic line', 'stdout and stderr must be observable without OS pipes');
      child.kill('SIGTERM');
      await Promise.resolve();
      assert(!table.isAlive(child.pid) && table.get(child.pid).signals.join(',') === 'SIGTERM', 'TERM must settle the injected child and process row');

      const stubborn = table.add({ pid: 2100, pgid: 2100, ignoreSignals: ['SIGTERM'] });
      table.add({ pid: 2101, ppid: stubborn.pid, pgid: stubborn.pgid, ignoreSignals: ['SIGTERM'] });
      table.killGroup(stubborn.pgid, 'SIGTERM');
      assert(table.isAlive(2100) && table.isAlive(2101), 'a TERM-ignoring group must remain alive for escalation tests');
      table.killGroup(stubborn.pgid, 'SIGKILL');
      assert(!table.isAlive(2100) && !table.isAlive(2101), 'KILL must terminate the whole injected group');
    },
  },
  {
    name: 'handoff bridge: tunnel: validators reject hostile values before any tunnel operation',
    async run() {
      const id = '123e4567-e89b-42d3-a456-426614174000';
      assert(validateTunnelId(id) === id && validateTunnelId(id.toUpperCase()) === null, 'tunnel IDs must be lowercase UUIDs');
      assert(validateTunnelId('00000000-0000-0000-0000-000000000000'), 'UUID validation is the frozen lowercase 8-4-4-4-12 shape, not a version policy');
      assert(validateCredentialsPath(`/Users/Ada Quenby/.cloudflared+prod/${id}.json`, id), 'the bounded safe credential-path character set must allow normal native-picker paths');
      for (const bad of ['relative.json', `/tmp/${id}.json/..`, `/tmp/${id}.JSON`, `/tmp/not-${id}.json`, `/tmp/${id}.json\n`, `/tmp/a:${id}.json`, `/tmp/a#${id}.json`, `/tmp/a{${id}.json`, `/tmp/a"${id}.json`, `/tmp/☃/${id}.json`, `/${'x'.repeat(1025)}/${id}.json`]) assert(validateCredentialsPath(bad, id) === null, `unsafe credentials path must fail: ${JSON.stringify(bad)}`);
      assert(validateTunnelConfig({ tunnelId: id, hostname: 'b-0123456789abcdef0123.lullascape.com', credentialsPath: `/tmp/${id}.json`, socketPath: '/tmp/bridge/b.sock' }), 'valid primitives compose');
      for (const hostname of ['Upper.Example.com', 'a..b.com', '127.0.0.1', 'a.b']) assert(!validateTunnelConfig({ tunnelId: id, hostname, credentialsPath: `/tmp/${id}.json`, socketPath: '/tmp/bridge/b.sock' }), `hostile hostname must fail: ${hostname}`);
    },
  },
  {
    name: 'handoff bridge: tunnel: redaction removes secrets paths hostnames opaque values and controls before storage',
    async run() {
      const sentinel = 'Tunnel' + 'Secret' + 'Value';
      const line = redactLine(`\u001b[31m${sentinel}=abc /Users/alice bridge.example.com ${'a'.repeat(48)}\u0000`, { home: '/Users/alice', hostname: 'bridge.example.com' });
      assert(!line.includes('=abc') && !line.includes('/Users/alice') && !line.includes('bridge.example.com') && !line.includes('a'.repeat(48)), 'redaction must run before log storage');
      assert(!line.includes(String.fromCharCode(0)) && !line.includes(String.fromCharCode(27)), 'controls must not survive a log line');
      const uuid = '123e4567-e89b-42d3-a456-426614174000'; const exact = redactLine(`/Users/alice/Library/App /Users/alice ${uuid} eyJ${'a'.repeat(50)}.x.y`, { home: '/Users/alice', userData: '/Users/alice/Library/App' });
      assert(exact.includes('<userData>') && exact.includes('~') && exact.includes('123e4567-...') && exact.includes('<jwt>'), 'redaction labels paths, UUID prefix and JWTs without exposing values');
      assert(!redactLine('Authorization: Bearer short-token').includes('short-token'), 'a short bearer value must be removed even when opaque-token fallback does not apply');
    },
  },
  {
    name: 'handoff bridge: tunnel: wrapper spawn is fully injected and passes only positional argv with shell disabled',
    run: () => {
      const table = createFakeProcessTable({ parentPid: 321 }); const fakeSpawn = createFakeSpawn({ processTable: table }); const lines = [];
      const child = spawnCloudflared({ appPid: 321, binaryPath: '/safe/copy/cloudflared-deadbeef', args: ['tunnel', '--config', '/safe/config.yml'], cwd: '/safe', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/tmp', TMPDIR: '/tmp' }, spawnImpl: fakeSpawn, onLine: line => lines.push(line) });
      assert(child === fakeSpawn.last().child && fakeSpawn.last().command === '/bin/sh', 'the watchdog wrapper is the only spawned process');
      assert(fakeSpawn.last().options.shell === false && fakeSpawn.last().options.detached === true, 'wrapper spawn must not invoke a shell interpolation mode');
      assert(fakeSpawn.last().args[1] === WATCHDOG_SCRIPT && fakeSpawn.last().args.includes('/safe/copy/cloudflared-deadbeef'), 'script and binary must be positional arguments');
      child.__writeStderr('key=value\n');
      assert(lines[0] === 'key=<redacted>', 'output must be redacted before the caller sees it');
    },
  },
  {
    name: 'handoff bridge: tunnel: reaper never signals foreign connectors and escalates only owned orphan groups',
    async run() {
      const calls = []; const pidfile = '/tmp/ic-reap/handoff-bridge/tunnel/tunnel.pid.json';
      const configPath = '/tmp/ic-reap/handoff-bridge/tunnel/config.yml';
      const fsPort = { existsSync: target => target === pidfile, readFileSync: () => JSON.stringify({ pid: 200, pgid: 200, lstart: 'Mon Jan  1 00:00:00 2026', configPath }), unlinkSync: target => calls.push(['unlink', target]) };
      const command = `/tmp/ic-reap/handoff-bridge/tunnel/bin/cloudflared-deadbeef tunnel --config ${configPath} --no-autoupdate run x`;
      const ps = `200 1 200 Mon Jan  1 00:00:00 2026 ${command}\n201 4 201 Mon Jan  1 00:00:00 2026 ${command}`;
      const alive = new Set([200, 201]);
      const kill = (pid, signal) => { calls.push(['kill', pid, signal]); if (signal === 'SIGKILL') alive.delete(Math.abs(pid)); return true; };
      const result = await reapOrphans({ userData: '/tmp/ic-reap', configPath, parentPid: 999, fsImpl: fsPort, exec: () => ps.split('\n').filter(line => !line.startsWith('200 ') || alive.has(200)).join('\n'), kill, wait: async () => undefined });
      assert(result.reaped === 1 && result.notices.includes('foreign-connector'), 'only ppid 1 or our live app is eligible');
      assert(calls.some(call => call[0] === 'kill' && call[1] === -200 && call[2] === 'SIGKILL') && !calls.some(call => call[1] === -201), 'only the owned orphan process group gets the bounded escalation');
    },
  },
  {
    name: 'handoff bridge: tunnel: reaper default wait lets each TERM and KILL grace period elapse',
    async run() {
      const root = '/tmp/reap-default-wait'; const configPath = `${root}/handoff-bridge/tunnel/config.yml`; const pidfile = `${root}/handoff-bridge/tunnel/tunnel.pid.json`;
      const command = `${root}/handoff-bridge/tunnel/bin/cloudflared-deadbeef tunnel --config ${configPath} --no-autoupdate run ${TUNNEL_ID}`;
      const alive = new Set([250]); const timers = []; const signals = [];
      const fsPort = { existsSync: target => target === pidfile, readFileSync: () => JSON.stringify({ pid: 250, pgid: 250, lstart: 'Mon Jan  1 00:00:00 2026', configPath }), unlinkSync() {} };
      const row = () => alive.has(250) ? `250 1 250 Mon Jan  1 00:00:00 2026 ${command}` : '';
      const result = await reapOrphans({ userData: root, configPath, fsImpl: fsPort, exec: () => row(), kill: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') alive.delete(Math.abs(pid)); }, setTimeoutImpl: (resolve, ms) => { timers.push(ms); queueMicrotask(resolve); } });
      assert(result.reaped === 1 && JSON.stringify(timers) === JSON.stringify([1500, 2500, 1500]), 'the production default wait must schedule every bounded grace period before the next recheck');
      assert(JSON.stringify(signals.map(([, signal]) => signal)) === JSON.stringify(['SIGTERM', 'SIGTERM', 'SIGKILL']), 'a stubborn owned group must retain TERM, TERM, KILL escalation through the default wait path');
    },
  },
  {
    name: 'handoff bridge: tunnel: supervisor serializes setup, classifies mandatory flag refusal and tracks unrequested exits separately',
    async run() {
      const clock = createFakeClock(); const table = createFakeProcessTable({ parentPid: 500 }); const fakeSpawn = createFakeSpawn({ processTable: table });
      const order = [];
      const supervisor = createTunnelSupervisor({ userData: '/tmp/ic-supervisor', hostname: 'b-0123456789abcdef0123.lullascape.com', socketPath: '/tmp/ic-supervisor/handoff-bridge/b.sock', credentialsPath: '/tmp/ignored.json', binaryPath: '/tmp/ignored', pin: 'pin', timers: clock, now: clock.now, testMode: true,
        reapOrphans: async () => { order.push('reap'); return { ok: true }; }, findBinary: () => '/tmp/ignored', inspectCredentials: () => { order.push('credentials'); return { ok: true, tunnelId: '123e4567-e89b-42d3-a456-426614174000', credentialsPath: '/tmp/123e4567-e89b-42d3-a456-426614174000.json' }; }, prepareBinary: () => { order.push('binary'); return { ok: true, copyPath: '/tmp/copy', sha256: 'pin', version: '2026.9.3' }; }, chooseMetricsPort: () => 50000,
        ensureTunnelDirectory: () => order.push('directory'), atomicWriteText: () => order.push('config'), dryRun: async (_binary, args) => ({ ok: true, output: args.at(-1) === 'validate' ? 'Validating rules from /tmp/ic-supervisor/handoff-bridge/tunnel/config.yml\nOK' : args.at(-1).includes('not-the-bridge') ? 'rule #1 http_status:404' : `rule #0 https://b-0123456789abcdef0123.lullascape.com/mcp unix:/tmp/ic-supervisor/handoff-bridge/b.sock` }), verifyPinnedCopy: () => ({ ok: true }), spawnCloudflared: args => { order.push('spawn'); return spawnCloudflared({ ...args, spawnImpl: fakeSpawn }); }, recordTunnelIntent: () => order.push('intent'), getProcessInfo: async pid => ({ pid, pgid: pid, lstart: 'synthetic' }), wait: async () => { await Promise.resolve(); },
      });
      const result = await supervisor.start();
      assert(result.ok && order.join(',') === 'directory,reap,credentials,binary,config,intent,spawn,intent', 'start must validate the state directory before serial reaping, trust, intent, spawn and pid update');
      fakeSpawn.last().child.__exit(0);
      await Promise.resolve();
      assert(supervisor.status().state === 'backoff', 'a clean unrequested exit is retried through its own guard');
      const restarted = await supervisor.start();
      assert(restarted.ok && fakeSpawn.calls.length === 2, 'the serial queue permits exactly one replacement after an exit');
      const paused = await supervisor.pause();
      assert(paused.ok && supervisor.status().state === 'paused' && fakeSpawn.calls.length === 2, 'pause must stop access rather than merely relabel a live child');
      const resumed = await supervisor.resume();
      assert(resumed.ok && fakeSpawn.calls.length === 3, 'resume starts one fresh wrapper and cannot duplicate the paused child');
    },
  },
  {
    name: 'handoff bridge: tunnel: reaper rejects PID reuse and preserves non-orphan rows without signal-zero probes',
    async run() {
      const configPath = '/tmp/reap-identity/handoff-bridge/tunnel/config.yml'; const pidfile = '/tmp/reap-identity/handoff-bridge/tunnel/tunnel.pid.json';
      const command = `/tmp/reap-identity/handoff-bridge/tunnel/bin/cloudflared-deadbeef tunnel --config ${configPath} --no-autoupdate run ${TUNNEL_ID}`;
      const scanned = `300 1 300 Mon Jan  1 00:00:00 2026 ${command}`;
      const recycled = `300 1 300 Tue Jan  2 00:00:00 2026 ${command}`;
      const calls = []; const fsPort = { existsSync: name => name === pidfile, readFileSync: () => JSON.stringify({ pid: 300, pgid: 300, configPath, lstart: 'Mon Jan  1 00:00:00 2026' }), unlinkSync: () => calls.push('unlink') };
      const result = await reapOrphans({ userData: '/tmp/reap-identity', configPath, fsImpl: fsPort, exec: (_name, args) => args.includes('-axww') ? scanned : recycled, kill: (...args) => calls.push(args) });
      assert(result.reaped === 0 && result.notices.includes('pid-reused') && calls.length === 0, 'identity mismatch must be a no-signal PID reuse refusal');
    },
  },
  {
    name: 'handoff bridge: tunnel: reaper cleans an untracked app child but leaves a tracked live child alone',
    async run() {
      const configPath = '/tmp/reap-child/handoff-bridge/tunnel/config.yml'; const pidfile = '/tmp/reap-child/handoff-bridge/tunnel/tunnel.pid.json';
      const command = `/tmp/reap-child/handoff-bridge/tunnel/bin/cloudflared-deadbeef tunnel --config ${configPath} --no-autoupdate run ${TUNNEL_ID}`;
      const alive = new Set([401]); const row = () => alive.has(401) ? `401 777 401 Mon Jan  1 00:00:00 2026 ${command}` : '';
      const signals = []; const fsPort = { existsSync: target => target === pidfile, readFileSync: () => JSON.stringify({ pid: 400, pgid: 400, lstart: 'stale', configPath }), unlinkSync: () => undefined };
      const result = await reapOrphans({ userData: '/tmp/reap-child', configPath, parentPid: 777, fsImpl: fsPort, exec: () => row(), kill: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGTERM') alive.delete(Math.abs(pid)); }, wait: async () => undefined });
      assert(result.reaped === 1 && result.notices.includes('untracked-own-child') && signals[0][0] === -401, 'an app-owned child omitted by the old pidfile must not block the next start');
    },
  },
  {
    name: 'handoff bridge: tunnel: config argv environment and watchdog script pin the Unix origin and mandatory flags',
    run: () => {
      const id = '123e4567-e89b-42d3-a456-426614174000';
      const socket = '/tmp/Application Support/ic/handoff-bridge/b.sock';
      const config = renderTunnelConfig({ tunnelId: id, hostname: 'b-0123456789abcdef0123.lullascape.com', credentialsPath: `/tmp/${id}.json`, socketPath: socket });
      assert(config.includes(`service: ${JSON.stringify(`unix:${socket}`)}`), 'the generated ingress must JSON-quote the Unix socket service');
      assert(config.includes('keepAliveConnections: 8') && config.includes('keepAliveTimeout: 30s'), 'the ingress timeout policy must be frozen');
      const argv = buildRunArgv({ configPath: '/tmp/config.yml', tunnelId: id, metricsPort: 50000 });
      assert(argv.join(' ').includes('--grace-period 2s') && argv.includes('--management-diagnostics=false') && argv.includes('--loglevel'), 'both mandatory safety flags and literal info logging must be present');
      assert(buildDryRunArgv({ configPath: '/tmp/config.yml', hostname: 'b-0123456789abcdef0123.lullascape.com' }).every(args => args.includes('--grace-period') && args.includes('--management-diagnostics=false')), 'offline validation must reject binaries that do not understand mandatory runtime flags');
      const env = buildChildEnv({ HOME: '/Users/test', TMPDIR: '/tmp/test' });
      assert(JSON.stringify(Object.keys(env)) === JSON.stringify(['PATH', 'HOME', 'TMPDIR']) && env.PATH === '/usr/bin:/bin:/usr/sbin:/sbin', 'child environment must be an exact allow-list');
      assert(WATCHDOG_SCRIPT === `app=$1; shift
"$@" & c=$!
s=
stopc() { kill -TERM "$c" 2>/dev/null; n=0; while kill -0 "$c" 2>/dev/null && [ "$n" -lt 12 ]; do sleep 0.2 & s=$!; wait $s; n=$((n+1)); done; kill -TERM "$c" 2>/dev/null; if kill -0 "$c" 2>/dev/null; then sleep 1 & s=$!; wait $s; kill -KILL "$c" 2>/dev/null; fi; wait "$c" 2>/dev/null; }
trap 'kill $s 2>/dev/null; stopc; exit 0' TERM INT
while kill -0 "$app" 2>/dev/null && kill -0 "$c" 2>/dev/null; do sleep 1 & s=$!; wait $s; done
stopc`, 'watchdog program bytes drifted from the measured interruptible TERM TERM KILL script');
    },
  },
  {
    name: 'handoff bridge: tunnel: classifications redaction ring metrics range and process ownership are deterministic',
    run: () => {
      assert(classifyExit({ code: 0, requested: false }) === 'exited-unrequested', 'clean unrequested exits need their own guard');
      assert(classifyExit({ code: 1, lines: ['flag provided but not defined'] }) === 'flag-rejected', 'required-flag rejection must be permanent');
      assert(classifyProbe({ status: 200, body: { resource: 'https://x/mcp' } }) === 'ok', 'a protected-resource document is online');
      assert(classifyProbe({ status: 530 }) === 'tunnel-not-serving' && classifyProbe({ publicAddress: false }) === 'hostname-not-public', 'probe failure classes must not collapse');
      const port = chooseMetricsPort({ random: () => 0 });
      assert(port >= 49152 && port <= 65535, 'metrics port must be in the dynamic range');
      assert(chooseMetricsPort({ random: () => 0, attempted: new Set([49152]) }) === 49153, 'a collision must advance instead of redrawing the same port');
      const ring = createLogRing({ maxLines: 2, maxBytes: 32 }); ring.add('one'); ring.add('two'); ring.add('three');
      assert(ring.values().length <= 2 && ring.size <= 32, 'log ring must be capped');
      const configPath = '/tmp/Application Support/ic/handoff-bridge/tunnel/config.yml';
      const row = parsePsRows(`200 1 200 Mon Jan  1 00:00:00 2026 /tmp/Application Support/ic/handoff-bridge/tunnel/bin/cloudflared-deadbeef tunnel --config ${configPath} --no-autoupdate run x`)[0];
      assert(isOwnedTunnelRow(row, { configPath, userData: '/tmp/Application Support/ic' }), 'only an app-owned copied binary plus exact config marker is reaped');
      assert(!isOwnedTunnelRow({ ...row, command: '/usr/local/bin/cloudflared tunnel --config ' + configPath + ' --no-autoupdate' }, { configPath, userData: '/tmp/Application Support/ic' }), 'bare or near-miss binaries are never reaped');
      assert(!isOwnedTunnelRow({ ...row, command: `/tmp/Application Support/ic/handoff-bridge/tunnel/bin/cloudflared-deadbeef --decoy /tmp/cloudflared-cafebabe tunnel --config ${configPath} --no-autoupdate run x` }, { configPath, userData: '/tmp/Application Support/ic' }), 'an earlier owned-looking substring cannot bless a foreign executable at the marker');
    },
  },
  {
    name: 'handoff bridge: tunnel: redaction precedes capped ring and mirror storage under a five-megabyte flood',
    run() {
      const secret = `Marisol-${'Q'.repeat(48)}`;
      const context = { home: '/Users/ada', userData: '/Users/ada/Library/Application Support/infinite-canvas', hostname: 'b-0123456789abcdef0123.lullascape.com' };
      const mirrored = [];
      const ring = createLogRing({ mirror: line => mirrored.push(line) });
      let inputBytes = 0;
      for (let index = 0; index < 1024; index++) {
        const raw = `authorization: ${secret} ${context.userData} ${context.hostname} ${TUNNEL_ID} query?code=${secret} ${'z'.repeat(5000)}`;
        inputBytes += Buffer.byteLength(raw);
        ring.add(redactLine(raw, context));
      }
      const stored = [...ring.values(), ...mirrored].join('\n');
      assert(inputBytes >= 5 * 1024 * 1024, 'the redaction fixture must actually exceed five MiB');
      for (const sentinel of [secret, context.home, context.userData, context.hostname, TUNNEL_ID, 'code=']) assert(!stored.includes(sentinel), `redacted storage leaked ${sentinel}`);
      assert(ring.values().length <= 400 && ring.size <= 128 * 1024 && mirrored.every(line => line.length <= 1024), 'both stored paths must see only bounded redacted lines');
    },
  },
  {
    name: 'handoff bridge: tunnel: generated shell launcher pins absolute paths and is executable',
    run: () => {
      const fixture = writeFakeCloudflaredLauncher();
      try {
        assert(fixture.text.startsWith('#!/bin/sh\nexec '), 'launcher must be a plain sh exec wrapper');
        assert(fixture.text.includes(JSON.stringify(process.execPath)), 'launcher must pin the absolute Node executable');
        assert(fixture.text.includes(JSON.stringify(path.resolve(fixture.fake))), 'launcher must pin the absolute fake script');
        assert(fixture.text.endsWith(' "$@"\n'), 'launcher must preserve argv without shell interpolation');
        assert((fs.statSync(fixture.directory).mode & 0o777) === 0o755, 'launcher directory must be 0755');
        assert((fs.statSync(fixture.launcher).mode & 0o777) === 0o755, 'launcher must be executable');
      } finally {
        fixture.cleanup();
      }
      assert(!fs.existsSync(fixture.directory), 'launcher fixture must clean its temporary directory');
    },
  },
  {
    name: 'handoff bridge: tunnel: fake cloudflared modes are import-inert and cover supervisor failures',
    run: () => {
      const source = fs.readFileSync(fakeUrl, 'utf8');
      for (const mode of ['ready', 'crash-on-start', 'crash-after-ready', 'hang-no-ready', 'ignore-sigterm', 'secret-in-log', 'record-argv-env', 'spawn-child', 'exit-clean-unrequested', 'reject-flag']) {
        assert(source.includes(`'${mode}'`), `fake cloudflared must retain ${mode} mode`);
      }
      assert(source.includes('path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)'), 'importing the fake must never execute a mode');
      assert(source.includes("if (mode === 'ignore-sigterm') return"), 'ignore-sigterm must install a real no-op handler');
      assert(source.includes("spawn(process.execPath"), 'spawn-child must use an absolute executable only out of band');
    },
  },
  {
    name: 'handoff bridge: tunnel: direct dry-run probe and rotating-log seams fail closed',
    async run() {
      const host = 'b-0123456789abcdef0123.lullascape.com'; const socket = '/tmp/b.sock';
      assert(validateDryRunOutput({ configPath: '/tmp/config.yml', hostname: host, socketPath: socket, validationOutput: 'Validating rules from /tmp/config.yml\nOK', matchingRuleOutput: `rule #0 https://${host}/mcp unix:${socket}`, fallbackRuleOutput: 'rule #1 http_status:404' }), 'exact dry-run output should pass');
      assert(!validateDryRunOutput({ configPath: '/tmp/config.yml', hostname: host, socketPath: socket, validationOutput: 'OK', matchingRuleOutput: '', fallbackRuleOutput: '' }), 'partial dry-run output must fail');
      assert(!validateDryRunOutput({ configPath: '/tmp/config.yml', hostname: host, socketPath: socket, validationOutput: 'Validating rules from /tmp/other.yml\nOK', matchingRuleOutput: `rule #0 https://${host}/mcp unix:${socket}`, fallbackRuleOutput: 'rule #1 http_status:404' }), 'a valid-looking result for another config must fail');
      const good = await publicProbe(host, { publicProbe: async () => ({ status: 200, body: { resource: `https://${host}/mcp` } }) });
      const bad = await publicProbe(host, { publicProbe: async () => ({ status: 200, body: { resource: 'https://other/mcp' } }) });
      assert(good.ok && bad.code === 'wrong-origin', 'I-9 must require an exact protected resource');
      let publicCall;
      await publicProbe(host, { publicProbe: async (url, options) => { publicCall = { url, options }; return { status: 200, body: { resource: `https://${host}/mcp` } }; } });
      assert(publicCall.url === `https://${host}/.well-known/oauth-protected-resource/mcp` && publicCall.options.redirect === 'manual' && publicCall.options.maxBodyBytes === 16 * 1024 && publicCall.options.signal, 'the guarded public-probe port must receive the exact URL and bounded manual-redirect contract');
      const writes = []; const fsPort = { existsSync: () => true, statSync: () => ({ size: 256 * 1024 }), renameSync: (...args) => writes.push(['rename', ...args]), appendFileSync: (...args) => writes.push(['append', ...args]), chmodSync: (...args) => writes.push(['chmod', ...args]) };
      createRotatingLog({ fsImpl: fsPort, target: '/tmp/cloudflared.log' })('synthetic');
      assert(writes.some(call => call[0] === 'rename') && writes.some(call => call[0] === 'chmod' && call[2] === 0o600), 'log mirror must rotate and force 0600');
    },
  },
  {
    name: 'handoff bridge: tunnel: binary test mode copies, pins, and skips host trust ports while production fails closed',
    async run() {
      const bytes = Buffer.alloc(5 * 1024 * 1024, 7); const mem = createMemoryBinaryFs(); const source = '/synthetic/cloudflared'; mem.add(source, bytes);
      for (const directory of ['/', '/users', '/users/test', '/users/prod', '/users/prod-verified']) mem.mkdirSync(directory);
      const crypto = awaitableCrypto(); const pin = crypto.hash(bytes);
      assert(findBinary('/missing/chosen', { existsSync: () => true }) === '/missing/chosen' && findBinary('/missing/chosen', { existsSync: () => false }) === null, 'an explicitly chosen unavailable binary must not silently fall back to PATH-like locations');
      let codesign = 0; let xattr = 0; let versionCalls = 0;
      const ensureDirectory = async (_root, target) => { mem.mkdirSync(target); return target; };
      let ancestorStats = 0; const originalStat = mem.statSync; mem.statSync = name => { if (name === '/users' || name === '/') ancestorStats++; return originalStat(name); };
      const testCopy = await prepareBinary({ userData: '/users/test', sourcePath: source, pin, testMode: true }, { fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory, random: () => Buffer.from('12345678'), codesign: () => { codesign++; return { verified: true }; }, xattr: () => { xattr++; return { present: true }; }, version: () => { versionCalls++; throw new Error('test mode must not execute the version probe'); } });
      assert(testCopy.ok && codesign === 0 && xattr === 0 && versionCalls === 0 && ancestorStats === 0, 'test mode must only copy and pin a pre-seeded fake without host trust probes');
      assert((mem.entries.get(testCopy.copyPath).mode & 0o777) === 0o500 && verifyPinnedCopy(testCopy.copyPath, pin, { fsImpl: mem, cryptoImpl: crypto, uid: 501 }).ok, 'the executed copy must be 0500 and pinned');
      const reused = await prepareBinary({ userData: '/users/test', sourcePath: source, pin, testMode: true }, { fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory, random: () => Buffer.from('abcdefgh') });
      assert(reused.ok && reused.copyPath === testCopy.copyPath, 'an identical immutable copied binary is safely reusable');
      const production = await prepareBinary({ userData: '/users/prod', sourcePath: source, pin, testMode: false }, { fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory, random: () => Buffer.from('abcdefgh'), codesign: () => ({ verified: false }), xattr: () => ({ present: false }), version: () => 'cloudflared version 2026.9.3' });
      assert(!production.ok, `an unsigned fake must be refused outside test mode (${JSON.stringify(production)})`);
      let productionVersionCalls = 0;
      const productionVerified = await prepareBinary({ userData: '/users/prod-verified', sourcePath: source, pin, testMode: false }, { fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory, random: () => Buffer.from('87654321'), codesign: () => ({ verified: true }), xattr: () => ({ present: false }), version: () => { productionVersionCalls++; return 'cloudflared version 2026.9.3'; } });
      assert(productionVerified.ok && productionVersionCalls === 1, 'production must retain the injected version probe after trust checks');
      const mismatch = await prepareBinary({ userData: '/users/test-mismatch', sourcePath: source, pin: '0'.repeat(64), testMode: true }, { fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory, random: () => Buffer.from('87654321') });
      assert(!mismatch.ok && mismatch.code === 'binary-changed', 'test mode must not weaken a mismatched pre-seeded pin');
      mem.entries.get(testCopy.copyPath).bytes[0] ^= 1;
      assert(!verifyPinnedCopy(testCopy.copyPath, pin, { fsImpl: mem, cryptoImpl: crypto, uid: 501 }).ok, 'a changed copy must refuse every spawn');
    },
  },
  {
    name: 'handoff bridge: tunnel: production binary permission quarantine signature and symlink matrix fails closed',
    async run() {
      const bytes = Buffer.alloc(5 * 1024 * 1024, 11); const crypto = awaitableCrypto();
      const make = () => {
        const mem = createMemoryBinaryFs();
        for (const directory of ['/', '/users', '/users/ada']) mem.mkdirSync(directory);
        const ensureDirectory = async (_root, target) => { mem.mkdirSync(target); return target; };
        return { mem, ensureDirectory };
      };
      const deps = (mem, ensureDirectory, extra = {}) => ({ fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory, random: () => Buffer.from('12345678'), xattr: () => ({ present: false }), codesign: () => ({ verified: true }), version: () => 'cloudflared version 2026.9.3', ...extra });

      const homebrew = make(); const chosen = '/opt/homebrew/bin/cloudflared'; const resolved = '/opt/homebrew/Cellar/cloudflared/2026.9.3/bin/cloudflared';
      homebrew.mem.add(chosen, Buffer.alloc(0), 0o777, { symlink: true, realpath: resolved }); homebrew.mem.add(resolved, bytes, 0o755);
      const originalStat = homebrew.mem.statSync; let sourceAncestorStats = 0;
      homebrew.mem.statSync = name => { if (name.startsWith('/opt/homebrew/') && name !== resolved) sourceAncestorStats++; return originalStat(name); };
      const accepted = await prepareBinary({ userData: '/users/ada', sourcePath: chosen, testMode: false }, deps(homebrew.mem, homebrew.ensureDirectory));
      assert(accepted.ok && sourceAncestorStats === 0, `a resolved Homebrew entry-point symlink and group-writable source ancestors are valid because only the app copy executes (${JSON.stringify({ accepted, sourceAncestorStats })})`);

      const copyAncestor = make(); copyAncestor.mem.add('/source/cloudflared', bytes, 0o755); copyAncestor.mem.entries.get('/users').mode = 0o775; copyAncestor.mem.entries.get('/users').gid = 80;
      const ancestorResult = await prepareBinary({ userData: '/users/ada', sourcePath: '/source/cloudflared', testMode: false }, deps(copyAncestor.mem, copyAncestor.ensureDirectory));
      assert(!ancestorResult.ok && ancestorResult.code === 'binary-unsafe-path', 'a group-writable copy ancestor is rejected with no gid-80 exemption');

      for (const [label, extra, expected] of [
        ['wrong owner', { uid: 999 }, 'binary-unsafe-path'],
        ['directory', { file: false }, 'binary-unsafe-path'],
        ['tiny', { bytes: Buffer.alloc(1024) }, 'binary-unsafe-path'],
        ['resolved symlink', { symlink: true }, 'binary-unsafe-path'],
      ]) {
        const item = make(); item.mem.add('/source/cloudflared', extra.bytes || bytes, 0o755, extra);
        const answer = await prepareBinary({ userData: '/users/ada', sourcePath: '/source/cloudflared', testMode: false }, deps(item.mem, item.ensureDirectory));
        assert(!answer.ok && answer.code === expected, `${label} source must be refused`);
      }

      const quarantined = make(); quarantined.mem.add('/source/cloudflared', bytes, 0o755);
      const quarantineResult = await prepareBinary({ userData: '/users/ada', sourcePath: '/source/cloudflared', testMode: false }, deps(quarantined.mem, quarantined.ensureDirectory, { xattr: () => ({ present: true }) }));
      assert(!quarantineResult.ok && quarantineResult.code === 'binary-quarantined' && ![...quarantined.mem.entries.keys()].some(name => name.includes('/.tmp-')), 'quarantine must be checked before copying bytes');

      const unsigned = make(); unsigned.mem.add('/source/cloudflared', bytes, 0o755);
      const signatureResult = await prepareBinary({ userData: '/users/ada', sourcePath: '/source/cloudflared', testMode: false }, deps(unsigned.mem, unsigned.ensureDirectory, { codesign: () => ({ verified: false }) }));
      assert(!signatureResult.ok && signatureResult.code === 'binary-signature-invalid' && ![...unsigned.mem.entries.keys()].some(name => name.includes('/.tmp-')), 'a failed signature check must delete the temporary copy');
    },
  },
  {
    name: 'handoff bridge: tunnel: config and argv goldens are byte-exact',
    run() {
      const hostname = 'b-0123456789abcdef0123.lullascape.com';
      const credentialsPath = `/Users/synthetic/.cloudflared/${TUNNEL_ID}.json`;
      const socketPath = '/Users/synthetic/Library/Application Support/infinite-canvas/handoff-bridge/b.sock';
      const config = renderTunnelConfig({ tunnelId: TUNNEL_ID, hostname, credentialsPath, socketPath });
      assert(config === `tunnel: ${TUNNEL_ID}\ncredentials-file: ${JSON.stringify(credentialsPath)}\ningress:\n  - hostname: ${hostname}\n    service: ${JSON.stringify(`unix:${socketPath}`)}\n    originRequest:\n      httpHostHeader: ${hostname}\n      connectTimeout: 5s\n      keepAliveConnections: 8\n      keepAliveTimeout: 30s\n  - service: http_status:404\n`, 'generated config bytes drifted');
      assert(JSON.stringify(buildRunArgv({ configPath: '/safe/config.yml', tunnelId: TUNNEL_ID, metricsPort: 49152 })) === JSON.stringify(['tunnel', '--config', '/safe/config.yml', '--no-autoupdate', '--loglevel', 'info', '--metrics', '127.0.0.1:49152', '--grace-period', '2s', '--label', 'infinite-canvas', '--management-diagnostics=false', 'run', TUNNEL_ID]), 'runtime argv drifted');
      assert(JSON.stringify(buildDryRunArgv({ configPath: '/safe/config.yml', hostname })) === JSON.stringify([
        ['tunnel', '--config', '/safe/config.yml', '--no-autoupdate', '--grace-period', '2s', '--management-diagnostics=false', 'ingress', 'validate'],
        ['tunnel', '--config', '/safe/config.yml', '--no-autoupdate', '--grace-period', '2s', '--management-diagnostics=false', 'ingress', 'rule', `https://${hostname}/mcp`],
        ['tunnel', '--config', '/safe/config.yml', '--no-autoupdate', '--grace-period', '2s', '--management-diagnostics=false', 'ingress', 'rule', 'https://not-the-bridge.invalid/'],
      ]), 'dry-run argv drifted');
    },
  },
  {
    name: 'handoff bridge: tunnel: state directories and setup state enforce ownership modes and bounded schema',
    async run() {
      const mem = createMemoryBinaryFs(); const root = '/users/synthetic'; mem.mkdirSync('/'); mem.mkdirSync('/users'); mem.mkdirSync(root);
      const walked = [];
      const ensureDirectory = async (_trusted, target) => { walked.push(target); mem.mkdirSync(target); return target; };
      const paths = await ensureTunnelDirectory(root, { fsImpl: mem, uid: 501, ensureDirectory });
      assert(walked.join('|') === [root, paths.bridge, paths.root, paths.bin].join('|'), 'every state component must be walked by the shared symlink-safe helper');
      assert([paths.bridge, paths.root, paths.bin].every(target => (mem.entries.get(target).mode & 0o777) === 0o700), 'all bridge directories must be 0700');
      const binaryPath = '/opt/homebrew/bin/cloudflared';
      const credentialsPath = `/users/synthetic/.cloudflared/${TUNNEL_ID}.json`;
      const pin = 'a'.repeat(64);
      const variants = [
        ['binary implicit draft', { binaryPath, pin }, { binaryPath, pin, approvedAt: null, binaryTrusted: false }],
        ['binary draft', { binaryPath, pin, approvedAt: null }, { binaryPath, pin, approvedAt: null, binaryTrusted: false }],
        ['binary approved', { binaryPath, pin, approvedAt: 123 }, { binaryPath, pin, approvedAt: 123, binaryTrusted: true }],
        ['credentials only', { credentialsPath }, { credentialsPath, binaryTrusted: false }],
        ['combined draft', { binaryPath, pin, approvedAt: null, credentialsPath }, { binaryPath, pin, approvedAt: null, credentialsPath, binaryTrusted: false }],
        ['combined approved', { binaryPath, pin, approvedAt: 456, credentialsPath }, { binaryPath, pin, approvedAt: 456, credentialsPath, binaryTrusted: true }],
      ];
      for (const [label, state, expected] of variants) {
        let nowCalls = 0;
        const saved = await writeTunnelState(root, { ...state, binaryTrusted: !expected.binaryTrusted, ignored: 'never stored' }, {
          fsImpl: mem, uid: 501, ensureDirectory, now: () => { nowCalls += 1; throw new Error('approval must not be defaulted'); },
        });
        assert(JSON.stringify(saved) === JSON.stringify({ v: 1, ...expected }) && Object.isFrozen(saved), `${label} must round trip as a frozen, derived setup projection`);
        assert(JSON.stringify(readTunnelState(root, { fsImpl: mem, uid: 501 })) === JSON.stringify(saved), `${label} must survive a fresh read`);
        const stored = JSON.parse(mem.readFileSync(paths.state, 'utf8'));
        assert(JSON.stringify(stored) === JSON.stringify({ v: 1, ...Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'binaryTrusted')) }), `${label} must write only canonical durable fields`);
        assert(!Object.hasOwn(stored, 'binaryTrusted') && nowCalls === 0 && (mem.entries.get(paths.state).mode & 0o777) === 0o600, `${label} may not serialize a trust bit, default approval, or relaxed mode`);
      }
      mem.entries.get(paths.state).bytes = Buffer.from(JSON.stringify({ v: 1, binaryPath, pin }));
      mem.entries.get(paths.state).mode = 0o600;
      assert(JSON.stringify(readTunnelState(root, { fsImpl: mem, uid: 501 })) === JSON.stringify({ v: 1, binaryPath, pin, approvedAt: null, binaryTrusted: false }), 'an older binary record without approval must rehydrate only as an untrusted draft');
      const invalidStates = [
        {}, { binaryPath }, { pin }, { binaryPath, pin: 'bad', approvedAt: null },
        { credentialsPath, pin }, { credentialsPath, approvedAt: null },
        { binaryPath, pin, approvedAt: '123' }, { binaryPath, pin, approvedAt: Number.POSITIVE_INFINITY },
        { v: 2, credentialsPath }, { binaryPath: 'relative/cloudflared', pin, approvedAt: null }, { credentialsPath: 'relative.json' },
      ];
      for (const state of invalidStates) {
        let rejected = null;
        try { await writeTunnelState(root, state, { fsImpl: mem, uid: 501, ensureDirectory }); } catch (error) { rejected = error; }
        assert(rejected?.code === 'config-rejected', `incoherent partial state must reject: ${JSON.stringify(state)}`);
      }
      const malformed = [
        { v: 1 }, { v: 1, binaryPath }, { v: 1, pin }, { v: 1, credentialsPath, approvedAt: null },
        { v: 1, binaryPath, pin, approvedAt: '123' }, { v: 2, credentialsPath },
      ];
      for (const state of malformed) {
        mem.entries.get(paths.state).bytes = Buffer.from(JSON.stringify(state));
        mem.entries.get(paths.state).mode = 0o600;
        assert(readTunnelState(root, { fsImpl: mem, uid: 501 }) === null, `malformed on-disk partial state must fail closed: ${JSON.stringify(state)}`);
      }
      // Restore a good state before the existing ownership/mode checks below.
      await writeTunnelState(root, { binaryPath, pin, approvedAt: 123, credentialsPath }, { fsImpl: mem, uid: 501, ensureDirectory });
      mem.entries.get(paths.state).mode = 0o644;
      assert(readTunnelState(root, { fsImpl: mem, uid: 501 }) === null, 'a relaxed setup-state mode must fail closed');
      mem.entries.get(paths.root).mode = 0o722;
      let unsafe; try { await ensureTunnelDirectory(root, { fsImpl: mem, uid: 501, ensureDirectory }); } catch (error) { unsafe = error; }
      assert(unsafe?.code === 'binary-unsafe-path', 'a group/world-writable tunnel directory must be refused');
      let escaped; try { await ensureTunnelDirectory(root, { fsImpl: mem, uid: 501, ensureDirectory: async (_trusted, target) => { if (target === paths.bridge) throw new Error('symbolic link'); mem.mkdirSync(target); } }); } catch (error) { escaped = error; }
      assert(escaped, 'a symlink-safe directory walk failure must stop before any tunnel operation');
    },
  },
  {
    name: 'handoff bridge: tunnel: credentials and pid intent are bounded and never return the secret',
    run() {
      const mem = createMemoryBinaryFs(); const credentialsPath = `/safe/${TUNNEL_ID}.json`;
      const secretKey = 'Tunnel' + 'Secret';
      mem.add(credentialsPath, Buffer.from(JSON.stringify({ TunnelID: TUNNEL_ID, [secretKey]: 'synthetic-value-that-is-long-enough-for-the-bounded-fixture' })), 0o400);
      const inspected = inspectCredentials(credentialsPath, { fsImpl: mem, uid: 501 });
      assert(inspected.ok && inspected.tunnelId === TUNNEL_ID && !JSON.stringify(inspected).includes('synthetic-value'), 'credential inspection may return identity and mode only');
      mem.entries.get(credentialsPath).mode = 0o600;
      assert(inspectCredentials(credentialsPath, { fsImpl: mem, uid: 501 }).ok, '0600 credentials must be accepted alongside 0400');
      mem.entries.get(credentialsPath).mode = 0o644;
      assert(!inspectCredentials(credentialsPath, { fsImpl: mem, uid: 501 }).ok, 'relaxed credential permissions must fail');
      mem.entries.get(credentialsPath).mode = 0o400;
      const validBytes = Buffer.from(JSON.stringify({ TunnelID: TUNNEL_ID, [secretKey]: 'synthetic-value-that-is-long-enough-for-the-bounded-fixture' }));
      for (const [label, candidate, extra] of [
        ['symlink', `/safe/symlink/${TUNNEL_ID}.json`, { bytes: validBytes, symlink: true }],
        ['wrong owner', `/safe/owner/${TUNNEL_ID}.json`, { bytes: validBytes, uid: 999 }],
        ['tiny', `/safe/tiny/${TUNNEL_ID}.json`, { bytes: Buffer.from('{}') }],
        ['oversized', `/safe/large/${TUNNEL_ID}.json`, { bytes: Buffer.alloc(4097, 1) }],
        ['invalid json', `/safe/json/${TUNNEL_ID}.json`, { bytes: Buffer.alloc(80, 120) }],
        ['TunnelID mismatch', `/safe/mismatch/${TUNNEL_ID}.json`, { bytes: Buffer.from(JSON.stringify({ TunnelID: '00000000-0000-0000-0000-000000000000', [secretKey]: 'synthetic-value-that-is-long-enough-for-the-bounded-fixture' })) }],
        ['unsafe path', `/safe/bad:name/${TUNNEL_ID}.json`, { bytes: validBytes }],
      ]) {
        mem.add(candidate, extra.bytes, 0o400, extra);
        assert(!inspectCredentials(candidate, { fsImpl: mem, uid: 501 }).ok, `${label} credentials must be refused`);
      }
      const root = '/safe/user'; const paths = tunnelPaths(root); for (const directory of ['/', '/safe', root, paths.bridge, paths.root]) mem.mkdirSync(directory);
      const intent = { pid: 401, pgid: 401, lstart: 'Mon Jan  1 00:00:00 2026', configPath: paths.config, createdAt: 10 };
      recordTunnelIntent(root, intent, { fsImpl: mem, random: () => Buffer.from('123456') });
      assert(JSON.parse(mem.readFileSync(paths.pid, 'utf8')).pid === 401 && (mem.entries.get(paths.pid).mode & 0o777) === 0o600, 'pid intent must be atomic and mode 0600');
      const shortWriteMem = createMemoryBinaryFs();
      for (const directory of ['/', '/safe', root, paths.bridge, paths.root]) shortWriteMem.mkdirSync(directory);
      const writeSync = shortWriteMem.writeSync;
      let writeCalls = 0;
      recordTunnelIntent(root, intent, {
        fsImpl: {
          ...shortWriteMem,
          writeSync(fd, bytes, offset, length) {
            writeCalls += 1;
            return writeSync(fd, bytes, offset, Math.min(7, length));
          },
        },
        random: () => Buffer.from('shorty'),
      });
      assert(writeCalls > 1 && JSON.parse(shortWriteMem.readFileSync(paths.pid, 'utf8')).configPath === paths.config,
        'a short write must loop until the complete Buffer intent is durably written');
      const zeroWriteMem = createMemoryBinaryFs();
      for (const directory of ['/', '/safe', root, paths.bridge, paths.root]) zeroWriteMem.mkdirSync(directory);
      let zeroWriteError;
      try {
        recordTunnelIntent(root, intent, {
          fsImpl: { ...zeroWriteMem, writeSync: () => 0 },
          random: () => Buffer.from('zeroed'),
        });
      } catch (error) { zeroWriteError = error; }
      assert(zeroWriteError && !zeroWriteMem.existsSync(paths.pid),
        'a write with no valid forward progress must fail closed without publishing an intent');
      for (const bad of [{ ...intent, pid: 1 }, { ...intent, pgid: 0 }, { ...intent, configPath: 'relative' }, { ...intent, lstart: '' }]) {
        let error; try { recordTunnelIntent(root, bad, { fsImpl: mem }); } catch (caught) { error = caught; }
        assert(error instanceof TypeError, 'malformed pid intent must be rejected before a write');
      }
    },
  },
  {
    name: 'handoff bridge: tunnel: an approved copy survives source upgrades and is rechecked before use',
    async run() {
      const bytes = Buffer.alloc(5 * 1024 * 1024, 9); const mem = createMemoryBinaryFs(); const source = '/synthetic/cloudflared'; mem.add(source, bytes);
      for (const directory of ['/', '/users', '/users/synthetic']) mem.mkdirSync(directory);
      const crypto = awaitableCrypto(); const pin = crypto.hash(bytes); const ensureDirectory = async (_root, target) => { mem.mkdirSync(target); return target; };
      const first = await prepareBinary({ userData: '/users/synthetic', sourcePath: source, pin, testMode: true }, { fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory, random: () => Buffer.from('12345678') });
      assert(first.ok, 'the pre-seeded pin must approve only its copied bytes');
      mem.entries.delete(source);
      const reused = await prepareBinary({ userData: '/users/synthetic', sourcePath: '/missing/new-version', pin, testMode: true }, { fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory });
      assert(reused.ok && reused.copyPath === first.copyPath && findApprovedCopy({ userData: '/users/synthetic', pin }, { fsImpl: mem, cryptoImpl: crypto, uid: 501 }).ok, 'a source upgrade or removal must not affect the immutable approved copy');
      mem.entries.get(first.copyPath).mode = 0o700;
      assert(!verifyPinnedCopy(first.copyPath, pin, { fsImpl: mem, cryptoImpl: crypto, uid: 501 }).ok, 'the copy mode is part of every pre-spawn trust check');
      mem.entries.get(first.copyPath).mode = 0o500; mem.entries.get(first.copyPath).bytes[3] ^= 1;
      const changed = await prepareBinary({ userData: '/users/synthetic', sourcePath: '/missing/new-version', pin, testMode: true }, { fsImpl: mem, cryptoImpl: crypto, uid: 501, ensureDirectory });
      assert(!changed.ok && changed.code === 'binary-changed', 'a changed approved copy must never be repaired silently from the mutable source');
    },
  },
  {
    name: 'handoff bridge: tunnel: binary probes use only bounded cwd output and the whitelisted environment',
    run() {
      let seen;
      const env = buildChildEnv({ HOME: '/Users/synthetic', TMPDIR: '/tmp/synthetic' });
      const output = execBinary('/safe/cloudflared', ['--version'], { cwd: '/safe', env, spawnSyncImpl: (_command, _args, options) => { seen = options; return { status: 0, stdout: 'cloudflared version 2026.9.3', stderr: '\nwarning' }; } });
      assert(output.includes('2026.9.3') && output.includes('warning') && seen.cwd === '/safe' && JSON.stringify(Object.keys(seen.env)) === JSON.stringify(['PATH', 'HOME', 'TMPDIR']) && seen.timeout === 5000 && seen.maxBuffer === 64 * 1024, 'binary execution must combine bounded stdout and stderr with no inherited environment');
      let refused; try { execBinary('/safe/cloudflared', [], { cwd: '/safe', env: { ...env, EXTRA: 'no' }, spawnSyncImpl: () => ({ status: 0 }) }); } catch (error) { refused = error; }
      assert(refused instanceof TypeError, 'an expanded child environment must be refused');
    },
  },
  {
    name: 'handoff bridge: tunnel: output keeps the safe front of oversized lines and contains hook failures',
    run() {
      const table = createFakeProcessTable({ parentPid: 321 }); const fakeSpawn = createFakeSpawn({ processTable: table }); const lines = [];
      const child = spawnCloudflared({ appPid: 321, binaryPath: '/safe/cloudflared-deadbeef', args: ['synthetic'], cwd: '/safe', env: buildChildEnv({ HOME: '/safe', TMPDIR: '/tmp' }), spawnImpl: fakeSpawn, redact: value => value, onLine: line => { lines.push(line); if (lines.length === 1) throw new Error('hook'); } });
      child.__writeStderr(`tunnel authentication rejected ${'x'.repeat(3000)}`);
      child.__writeStderr(`${'y'.repeat(100)}\nsecond\n`);
      assert(lines[0].startsWith('tunnel authentication rejected') && lines[0].length === 1024 && lines[1] === 'second', 'truncation must retain the classifying front and resume at the next line');
    },
  },
  {
    name: 'handoff bridge: tunnel: reaper treats wrapper and child as one owned orphan group',
    async run() {
      const root = '/tmp/reap-group'; const configPath = `${root}/handoff-bridge/tunnel/config.yml`; const pidfile = `${root}/handoff-bridge/tunnel/tunnel.pid.json`;
      const command = `${root}/handoff-bridge/tunnel/bin/cloudflared-deadbeef tunnel --config ${configPath} --no-autoupdate run ${TUNNEL_ID}`;
      const rows = new Map([[600, { pid: 600, ppid: 1, pgid: 600, lstart: 'Mon Jan  1 00:00:00 2026', command }], [601, { pid: 601, ppid: 600, pgid: 600, lstart: 'Mon Jan  1 00:00:01 2026', command }]]);
      const line = row => `${row.pid} ${row.ppid} ${row.pgid} ${row.lstart} ${row.command}`; const signals = [];
      const fsPort = { existsSync: target => target === pidfile, readFileSync: () => JSON.stringify({ pid: 600, pgid: 600, lstart: rows.get(600)?.lstart, configPath }), unlinkSync() {} };
      const exec = (_name, args) => args.includes('-axww') ? [...rows.values()].map(line).join('\n') : rows.has(Number(args[1])) ? line(rows.get(Number(args[1]))) : '';
      const result = await reapOrphans({ userData: root, configPath, parentPid: 999, fsImpl: fsPort, exec, kill: (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGTERM') rows.clear(); }, wait: async () => undefined });
      assert(result.reaped === 1 && !result.notices.includes('foreign-connector') && signals[0][0] === -600, 'a wrapper parent is an owned group member, not a foreign owner');
    },
  },
  {
    name: 'handoff bridge: tunnel: reaper stops escalation if a PID is reused after the first signal',
    async run() {
      const root = '/tmp/reap-reuse-after'; const configPath = `${root}/handoff-bridge/tunnel/config.yml`; const pidfile = `${root}/handoff-bridge/tunnel/tunnel.pid.json`; const command = `${root}/handoff-bridge/tunnel/bin/cloudflared-deadbeef tunnel --config ${configPath} --no-autoupdate run ${TUNNEL_ID}`;
      let changed = false; const signals = [];
      const scanned = `700 1 700 Mon Jan  1 00:00:00 2026 ${command}`; const current = () => `700 1 700 ${changed ? 'Tue Jan  2 00:00:00 2026' : 'Mon Jan  1 00:00:00 2026'} ${command}`;
      const fsPort = { existsSync: target => target === pidfile, readFileSync: () => JSON.stringify({ pid: 700, pgid: 700, lstart: 'Mon Jan  1 00:00:00 2026', configPath }), unlinkSync() {} };
      const result = await reapOrphans({ userData: root, configPath, fsImpl: fsPort, exec: (_name, args) => args.includes('-axww') ? scanned : current(), kill: (pid, signal) => { signals.push([pid, signal]); changed = true; }, wait: async () => undefined });
      assert(result.notices.includes('pid-reused') && signals.length === 1 && signals[0][1] === 'SIGTERM', 'identity drift after TERM must prevent a second TERM or KILL');
    },
  },
  {
    name: 'handoff bridge: tunnel: reaper handles absent corrupt dead live foreign and ps-failure rows without unsafe signals',
    async run() {
      const root = '/tmp/reap-table'; const configPath = `${root}/handoff-bridge/tunnel/config.yml`; const pidfile = `${root}/handoff-bridge/tunnel/tunnel.pid.json`;
      let execCalls = 0; const absent = await reapOrphans({ userData: root, configPath, fsImpl: { existsSync: () => false }, exec: () => { execCalls++; return ''; } });
      assert(absent.reaped === 0 && execCalls === 0, 'no pidfile must mean no ps call');

      const removed = []; const corrupt = await reapOrphans({ userData: root, configPath, fsImpl: { existsSync: () => true, readFileSync: () => '{', unlinkSync: target => removed.push(target) }, exec: () => { throw new Error('must not run'); } });
      assert(corrupt.notices.includes('stale-pidfile') && removed[0] === pidfile, 'a corrupt pidfile is deleted without ps or a signal');

      const intent = JSON.stringify({ pid: 800, pgid: 800, lstart: 'Mon Jan  1 00:00:00 2026', configPath });
      const baseFs = { existsSync: () => true, readFileSync: () => intent, unlinkSync: target => removed.push(target) };
      const psFailed = await reapOrphans({ userData: root, configPath, fsImpl: baseFs, exec: () => { throw new Error('ps'); } });
      assert(psFailed.notices.includes('ps-failed'), 'a ps failure is a warning and does not throw');

      const owned = `${root}/handoff-bridge/tunnel/bin/cloudflared-deadbeef tunnel --config ${configPath} --no-autoupdate run ${TUNNEL_ID}`;
      const row = `800 777 800 Mon Jan  1 00:00:00 2026 ${owned}`; const signals = [];
      const live = await reapOrphans({ userData: root, configPath, parentPid: 777, fsImpl: baseFs, exec: () => row, kill: (...args) => signals.push(args) });
      assert(live.notices.includes('live-child') && signals.length === 0, 'the tracked child of this live app is observed, never reaped');

      const dead = await reapOrphans({ userData: root, configPath, fsImpl: baseFs, exec: (_name, args) => { if (args.includes('-axww')) return row.replace('800 777', '800 1'); throw Object.assign(new Error('selected pid vanished'), { status: 1 }); }, kill: (...args) => signals.push(args) });
      assert(dead.notices.includes('stale-pidfile') && signals.length === 0, 'a row gone at identity recheck is deleted without signalling by stale pid');

      const foreignCommand = `/usr/local/bin/cloudflared tunnel --config /tmp/lab-config.yml --no-autoupdate run lab`;
      const foreign = await reapOrphans({ userData: root, configPath, fsImpl: baseFs, exec: () => `900 1 900 Mon Jan  1 00:00:00 2026 ${foreignCommand}`, kill: (...args) => signals.push(args) });
      assert(foreign.notices.includes('foreign-connector') && signals.length === 0, 'a hand-run foreign connector is advisory only');
    },
  },
  {
    name: 'handoff bridge: tunnel: supervisor start order and ten-probe audit are deterministic',
    async run() {
      let reaps = 0; const harness = createSupervisorHarness({ reapOrphans: async () => { reaps++; return { ok: true, notices: reaps === 1 ? ['foreign-connector'] : [] }; } });
      const started = await harness.supervisor.start();
      assert(started.ok && harness.order.join(',') === 'directory,credentials,binary,config,dry:validate,dry:https://b-0123456789abcdef0123.lullascape.com/mcp,dry:https://not-the-bridge.invalid/,verify,intent:pre,spawn,intent:live', 'start must serialize every trust and durability step around spawn');
      for (let index = 0; index < 10; index++) await harness.supervisor.probe();
      assert(reaps === 2 && harness.supervisor.status().notices.includes('foreign-connector'), 'the tenth probe must run the audit reaper even while public probes are healthy');
      await harness.supervisor.stop();
    },
  },
  {
    name: 'handoff bridge: tunnel: supervisor gate refusals return fixed codes and leave no child running',
    async run() {
      const cases = [
        ['bad userData', { userData: 'relative' }, 'config-rejected'],
        ['unsafe directory', { ensureTunnelDirectory: async () => { throw new Error('unsafe'); } }, 'config-rejected'],
        ['stuck orphan', { reapOrphans: async () => ({ ok: true, notices: ['orphan-stuck'] }) }, 'owned-elsewhere'],
        ['credentials', { inspectCredentials: () => ({ ok: false, code: 'credentials-invalid' }) }, 'credentials-invalid'],
        ['binary', { prepareBinary: async () => ({ ok: false, code: 'binary-quarantined' }) }, 'binary-quarantined'],
        ['metrics', { chooseMetricsPort: () => null }, 'spawn-failed'],
        ['config write', { atomicWriteText: () => { throw new Error('disk'); } }, 'config-rejected'],
        ['mandatory flag', { dryRun: async () => ({ ok: false, output: 'flag provided but not defined: --grace-period' }) }, 'flag-rejected'],
        ['changed copy', { verifyPinnedCopy: () => ({ ok: false, code: 'binary-changed' }) }, 'binary-changed'],
        ['spawn', { spawnCloudflared: () => { throw new Error('spawn'); } }, 'spawn-failed'],
        ['process group', { getProcessInfo: async () => null }, 'spawn-failed'],
        ['process lookup throw', { getProcessInfo: async () => { throw new Error('ps'); } }, 'spawn-failed'],
      ];
      for (const [label, overrides, code] of cases) {
        const harness = createSupervisorHarness(overrides);
        const answer = await harness.supervisor.start(); await flush();
        assert(!answer.ok && answer.code === code && harness.supervisor.status().state === 'failed', `${label} must fail as ${code}`);
        assert(harness.fakeSpawn.calls.every(call => call.child.exitCode !== null || call.child.signalCode !== null), `${label} left a spawned process alive`);
      }
    },
  },
  {
    name: 'handoff bridge: tunnel: notices privacy and permanent public-probe failures stay contained',
    async run() {
      const oldClock = createFakeClock(181 * 24 * 60 * 60_000); const mirrored = [];
      const harness = createSupervisorHarness({ clock: oldClock, approvedAt: 0, legacyCertPresent: () => true, mirrorLog: line => mirrored.push(line), publicProbeFn: async () => ({ ok: false, code: 'hostname-not-public' }) });
      const started = await harness.supervisor.start(); const secret = `Ada-${'S'.repeat(48)}`;
      harness.fakeSpawn.last().child.__writeStderr(`authorization: ${secret}\n`);
      const probed = await harness.supervisor.probe(); await flush();
      const serialized = JSON.stringify({ started, probed, status: harness.supervisor.status(), audits: harness.audits, mirrored });
      assert(harness.supervisor.status().state === 'failed' && harness.supervisor.status().lastExit === 'hostname-not-public', `a non-public hostname must stop the connector and fail permanently (${JSON.stringify(harness.supervisor.status())})`);
      assert(harness.fakeSpawn.last().child.exitCode !== null || harness.fakeSpawn.last().child.signalCode !== null, 'a permanent public-probe refusal must not leave public access running');
      assert(harness.supervisor.status().notices.includes('cert-present') && harness.supervisor.status().notices.includes('binary-old'), 'legacy cert and old approved copy are fixed notices');
      assert(!serialized.includes(secret) && mirrored.some(line => line.includes('<redacted>')), 'free-form tunnel output must be redacted before every observable surface');
    },
  },
  {
    name: 'handoff bridge: tunnel: supervisor diagnostics are bounded, redacted, and never control an orphan',
    async run() {
      const secret = `Ada-${'S'.repeat(48)}`;
      const harness = createSupervisorHarness({ rawLine: `authorization: ${secret} /tmp/ic-supervisor-matrix ${TUNNEL_ID} b-0123456789abcdef0123.lullascape.com` });
      const before = harness.supervisor.getLog();
      assert(Array.isArray(before) && before.length === 0 && Object.isFrozen(before), 'an off supervisor exposes only an empty immutable diagnostic view');
      await harness.supervisor.start();
      const lines = harness.supervisor.getLog({ limit: 999 });
      assert(Object.isFrozen(lines) && lines.length <= 100 && lines.every(line => typeof line === 'string' && line.length <= 1024), 'diagnostics must be a capped string-only snapshot');
      const joined = lines.join('\n');
      for (const forbidden of [secret, '/tmp/ic-supervisor-matrix', TUNNEL_ID, 'b-0123456789abcdef0123.lullascape.com']) assert(!joined.includes(forbidden), `diagnostics leaked ${forbidden}`);
      assert(typeof harness.supervisor.stopOrphan === 'undefined', 'the supervisor never offers a renderer-selectable PID or orphan kill path');
      await harness.supervisor.stop();
      assert(harness.supervisor.getLog().length === lines.length, 'stopping preserves the in-memory redacted diagnostic snapshot without reading a log file');
    },
  },
  {
    name: 'handoff bridge: tunnel: real binding re-probes on resume and removes its optional power listener',
    async run() {
      let resume = null; let removed = false; let probes = 0;
      const powerMonitor = { on(event, callback) { if (event === 'resume') resume = callback; }, removeListener(event, callback) { if (event === 'resume' && callback === resume) removed = true; } };
      const base = createSupervisorHarness();
      const supervisor = createRealTunnelSupervisor({ ...base.options, powerMonitor, publicProbeFn: async () => { probes++; return { ok: true, code: 'ok' }; } });
      await supervisor.start();
      assert(typeof resume === 'function', 'the real binding must optional-chain the resume listener');
      resume(); await flush();
      assert(probes >= 1, 'resume must trigger a fresh tunnel probe');
      await supervisor.dispose();
      assert(removed, 'dispose must remove the optional power listener');
    },
  },
  {
    name: 'handoff bridge: tunnel: probe reaper and signal port throws do not strand supervision',
    async run() {
      let reaps = 0;
      const probes = createSupervisorHarness({
        probeReady: async () => { throw new Error('ready port'); },
        publicProbeFn: async () => { throw new Error('public port'); },
        reapOrphans: async () => { reaps++; if (reaps > 1) throw new Error('ps port'); return { ok: true, notices: [] }; },
      });
      await probes.supervisor.start();
      for (let index = 0; index < 10; index++) await probes.supervisor.probe();
      assert(reaps === 2 && probes.supervisor.status().state === 'degraded' && probes.fakeSpawn.last().child.exitCode === null, 'probe and audit faults must degrade while the supervised child remains owned');
      await probes.supervisor.stop();

      const signals = createSupervisorHarness({ signalGroup: () => { throw new Error('signal port'); } });
      await signals.supervisor.start(); const stopped = await signals.supervisor.stop();
      assert(stopped.ok && signals.fakeSpawn.last().child.signalCode === 'SIGTERM', 'a throwing group-signal port must fall back to the verified child handle');
    },
  },
  {
    name: 'handoff bridge: tunnel: public probe telemetry is closed, immutable and drives online/degraded transitions',
    async run() {
      const replies = [
        { ok: false, code: 'edge-unreachable' },
        { ok: false, code: 'untrusted response text /tmp/secret' },
        { ok: false, code: 'origin-unreachable' },
        { ok: true, code: 'ok' },
      ];
      const harness = createSupervisorHarness({ publicProbeFn: async () => replies.shift() });
      await harness.supervisor.start();
      const before = harness.supervisor.status();
      assert(Object.isFrozen(before) && Object.isFrozen(before.probe) && before.probe.state === 'unknown' && before.probe.consecutiveFailures === 0, 'a new run must expose an immutable neutral probe snapshot before the first public check');
      await harness.supervisor.probe();
      const first = harness.supervisor.status().probe;
      assert(first.state === 'failing' && first.reason === 'edge-unreachable' && first.consecutiveFailures === 1 && Number.isFinite(first.failingSince), 'the first failed public check must retain only its closed class and failure time');
      await harness.supervisor.probe();
      const second = harness.supervisor.status().probe;
      assert(second.state === 'failing' && second.reason === 'other' && second.consecutiveFailures === 2 && second.failingSince === first.failingSince, 'an injected diagnostic must be collapsed while a single outage retains its first-failure timestamp');
      await harness.supervisor.probe();
      const degraded = harness.supervisor.status();
      assert(degraded.state === 'degraded' && degraded.probe.reason === 'origin-unreachable' && degraded.probe.consecutiveFailures === 3, 'three public failures must visibly degrade the connector with the last closed class');
      await harness.supervisor.probe();
      const recovered = harness.supervisor.status();
      assert(recovered.state === 'online' && recovered.probe.state === 'ok' && recovered.probe.consecutiveFailures === 0 && recovered.probe.failingSince === null && Number.isFinite(recovered.probe.okAt) && recovered.probe.reason === null, 'one successful public check must restore online status and clear the active failure streak');
      await harness.supervisor.stop();
    },
  },
  {
    name: 'handoff bridge: tunnel: transient network exits follow the full 1 2 4 8 16 30 backoff ladder',
    async run() {
      const harness = createSupervisorHarness(); await harness.supervisor.start();
      for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
        const child = harness.fakeSpawn.last().child; child.__writeStderr('network is unreachable\n'); child.__exit(1); await flush();
        assert(harness.supervisor.status().state === 'backoff', 'network loss must remain retryable without entering a crash loop');
        const pending = harness.clock.pending(); const delay = Math.min(...pending.map(timer => timer.at - harness.clock.now()));
        assert(delay === expected, `expected ${expected}ms backoff, got ${delay}`);
        harness.clock.advance(expected); await flush();
        assert(harness.fakeSpawn.last().child !== child, 'the retry timer must start one replacement wrapper');
      }
      await harness.supervisor.stop();
    },
  },
  {
    name: 'handoff bridge: tunnel: exit classification uses only the current child output',
    async run() {
      const harness = createSupervisorHarness(); await harness.supervisor.start();
      harness.fakeSpawn.last().child.__writeStderr('network is unreachable\n');
      harness.fakeSpawn.last().child.__exit(1); await flush();
      harness.clock.advance(1_000); await flush();
      harness.fakeSpawn.last().child.__exit(1); await flush();
      assert(harness.supervisor.status().lastExit === 'exited-early', 'a prior child network line must not poison a replacement child classification');
      await harness.supervisor.stop();
    },
  },
  {
    name: 'handoff bridge: tunnel: a metrics collision retries with a different dynamic port',
    async run() {
      const harness = createSupervisorHarness({ chooseMetricsPort: ({ attempted }) => chooseMetricsPort({ random: () => 0, attempted }) });
      await harness.supervisor.start();
      const first = harness.fakeSpawn.last();
      assert(first.args.includes('127.0.0.1:49152'), 'the first deterministic metrics port must be recorded in argv');
      first.child.__writeStderr('address already in use\n'); first.child.__exit(1); await flush();
      const delay = Math.min(...harness.clock.pending().map(timer => timer.at - harness.clock.now())); harness.clock.advance(delay); await flush();
      assert(harness.fakeSpawn.last().args.includes('127.0.0.1:49153'), 'the failed metrics port must not be selected on the retry');
      await harness.supervisor.stop();
    },
  },
  {
    name: 'handoff bridge: tunnel: crash and clean-unrequested guards are independent and alarm once',
    async run() {
      const crash = createSupervisorHarness(); await crash.supervisor.start();
      for (let index = 0; index < 5; index++) {
        crash.fakeSpawn.last().child.__exit(1); await flush();
        if (index < 4) { const delay = Math.min(...crash.clock.pending().map(timer => timer.at - crash.clock.now())); crash.clock.advance(delay); await flush(); }
      }
      assert(crash.supervisor.status().state === 'failed' && crash.supervisor.status().lastExit === 'crash-loop' && crash.alarms.join(',') === 'crash-loop', 'five non-zero exits must hit only the crash-loop guard');
      const clean = createSupervisorHarness(); await clean.supervisor.start();
      for (let index = 0; index < 3; index++) {
        clean.fakeSpawn.last().child.__exit(0); await flush();
        if (index < 2) { const delay = Math.min(...clean.clock.pending().map(timer => timer.at - clean.clock.now())); clean.clock.advance(delay); await flush(); }
      }
      assert(clean.supervisor.status().state === 'failed' && clean.supervisor.status().lastExit === 'unrequested-exit-loop' && clean.audits.some(entry => entry.event === 'tunnel_unrequested_exit_loop'), 'three clean unrequested exits must use their separate security guard');
    },
  },
  {
    name: 'handoff bridge: tunnel: permanent exit classes never schedule a retry',
    async run() {
      const harness = createSupervisorHarness(); await harness.supervisor.start();
      harness.fakeSpawn.last().child.__writeStderr('tunnel authentication rejected\n'); harness.fakeSpawn.last().child.__exit(1); await flush();
      assert(harness.supervisor.status().state === 'failed' && harness.supervisor.status().lastExit === 'tunnel-auth-rejected' && harness.clock.pendingCount() === 0, 'authentication rejection must be permanent and timer-free');
    },
  },
  {
    name: 'handoff bridge: tunnel: stop escalates TERM TERM KILL and manual restart is rate limited',
    async run() {
      const harness = createSupervisorHarness({ ignoreTerm: true }); await harness.supervisor.start();
      const stopped = await harness.supervisor.stop();
      assert(stopped.ok && harness.order.filter(value => value.startsWith('signal:')).join(',') === 'signal:SIGTERM,signal:SIGTERM,signal:SIGKILL' && harness.order.filter(value => value.startsWith('wait:')).join(',') === 'wait:1500,wait:2500,wait:1500', 'a TERM-ignoring group must reach the exact bounded KILL ladder');
      const restart = createSupervisorHarness(); await restart.supervisor.start();
      const first = await restart.supervisor.restart(); const second = await restart.supervisor.restart();
      assert(first.ok && !second.ok && second.code === 'busy' && restart.fakeSpawn.calls.length === 2, 'manual restart must admit only one request per five seconds');
      await restart.supervisor.stop();
      const stuck = createSupervisorHarness({ signalGroup: () => true }); await stuck.supervisor.start();
      const stuckRestart = await stuck.supervisor.restart();
      assert(!stuckRestart.ok && stuckRestart.code === 'stop-stuck' && stuck.fakeSpawn.calls.length === 1, 'a stuck old group must block replacement instead of creating a second connector');
      stuck.fakeSpawn.last().child.__exit(null, 'SIGKILL'); await flush();
    },
  },
  {
    name: 'handoff bridge: tunnel: stop during start cancels before spawn and timer-port faults fail closed',
    async run() {
      let releaseDry; const blocked = new Promise(resolve => { releaseDry = resolve; }); let first = true;
      const harness = createSupervisorHarness({ dryRun: async (_binary, args) => { if (first) { first = false; await blocked; } return { ok: true, output: args.at(-1) === 'validate' ? `Validating rules from /tmp/ic-supervisor-matrix/handoff-bridge/tunnel/config.yml\nOK` : args.at(-1).includes('not-the-bridge') ? 'rule #1 http_status:404' : 'rule #0 https://b-0123456789abcdef0123.lullascape.com/mcp unix:/tmp/ic-supervisor-matrix/handoff-bridge/b.sock' }; } });
      const starting = harness.supervisor.start(); await flush(8); const stopping = harness.supervisor.stop(); releaseDry();
      const [startResult, stopResult] = await Promise.all([starting, stopping]);
      assert(!startResult.ok && stopResult.ok && harness.fakeSpawn.calls.length === 0 && harness.supervisor.status().state === 'off', 'a queued stop must invalidate setup before a child is spawned');
      const timerFault = createSupervisorHarness({ timers: { setTimeout() { throw new Error('timer'); }, clearTimeout() { throw new Error('clear'); } } });
      const result = await timerFault.supervisor.start(); await flush();
      assert(!result.ok && result.code === 'spawn-failed' && timerFault.supervisor.status().state === 'failed' && timerFault.supervisor.status().lastExit === 'spawn-failed', 'timer construction faults after spawn must kill the group and fail closed without rejection');
      await timerFault.supervisor.stop();
    },
  },
  {
    name: 'handoff bridge: tunnel: macOS system aliases preserve trusted roots but reject nested links',
    run: async () => {
      if (process.platform !== 'darwin') return { skipped: 'darwin-only' };
      const roots = [];
      let outsideRoot = '';
      try {
        const realTemporaryParent = await fs.promises.realpath(os.tmpdir());
        assert(realTemporaryParent.startsWith('/private/var/'),
          'the macOS temporary directory fixture must resolve through /private/var');
        const lexicalTemporaryParent = `/var${realTemporaryParent.slice('/private/var'.length)}`;
        for (const [temporaryParent, lexicalPrefix, canonicalPrefix] of [
          [lexicalTemporaryParent, '/var', '/private/var'],
          ['/tmp', '/tmp', '/private/tmp'],
        ]) {
          const lexicalRoot = await fs.promises.mkdtemp(path.join(temporaryParent, 'local-ai-system-alias-'));
          roots.push(lexicalRoot);
          const realRoot = await fs.promises.realpath(lexicalRoot);
          assert(realRoot === `${canonicalPrefix}${lexicalRoot.slice(lexicalPrefix.length)}`,
            `${lexicalPrefix} fixture must resolve through its macOS /private alias`);
          const trustedDir = await ensureDirectoryWithinRoot(lexicalRoot, path.join(lexicalRoot, 'trusted'), {
            label: 'Local AI macOS system alias',
          });
          assert(await fs.promises.realpath(trustedDir) === path.join(realRoot, 'trusted'),
            `${lexicalPrefix} descendants remain usable through the trusted lexical root`);
        }

        const realEtcSsl = await fs.promises.realpath('/etc/ssl');
        const trustedEtcSsl = await ensureDirectoryWithinRoot('/etc/ssl', '/etc/ssl', {
          label: 'Local AI macOS system alias',
        });
        assert(realEtcSsl.startsWith('/private/etc/') && trustedEtcSsl === realEtcSsl,
          '/etc descendants use the same narrowly allowed macOS alias');

        outsideRoot = await fs.promises.mkdtemp('/tmp/local-ai-system-alias-outside-');
        const linkedDir = path.join(roots[0], 'attacker-controlled');
        await fs.promises.symlink(outsideRoot, linkedDir, 'dir');
        let symlinkError = null;
        try {
          await ensureDirectoryWithinRoot(roots[0], path.join(linkedDir, 'created'), {
            label: 'Local AI macOS system alias',
          });
        } catch (error) { symlinkError = error; }
        assert(/symbolic link|resolved outside/i.test(String(symlinkError?.message || '')),
          'a nested attacker-controlled symlink remains rejected under a system alias');
        assert(!fs.existsSync(path.join(outsideRoot, 'created')),
          'rejecting the nested symlink does not create a directory at its target');
      } finally {
        await Promise.all([
          ...roots.map(root => fs.promises.rm(root, { recursive: true, force: true })),
          ...(outsideRoot ? [fs.promises.rm(outsideRoot, { recursive: true, force: true })] : []),
        ]);
      }
      return { aliases: 3, symlinkTraversalBlocked: true };
    },
  },
  ...B3_MATRIX,
];

function awaitableCrypto() {
  const nodeCrypto = { createHash: () => {
    const chunks = []; const hash = { update: bytes => { chunks.push(Buffer.from(bytes)); return hash; }, digest: encoding => {
      const sum = Buffer.concat(chunks).reduce((value, byte) => (value * 33 + byte) >>> 0, 5381).toString(16).padStart(64, '0');
      return encoding === 'hex' ? sum : Buffer.from(sum, 'hex');
    } }; return hash;
  } };
  nodeCrypto.hash = bytes => nodeCrypto.createHash('sha256').update(bytes).digest('hex');
  return nodeCrypto;
}
