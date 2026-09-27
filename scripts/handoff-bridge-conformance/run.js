/*
 * Out-of-band Phase 1 conformance.  This nested package deliberately owns
 * SDK 1.30.1 and zod 4; it never reaches the public network or Cloudflare.
 * Real transport tests use only a fresh Unix socket below os.tmpdir().
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

let createAuditSink;
let CONSTANTS;
let validateClientMetadata;
let createHandoffEngine;
let createRequestHandler;
let createLaneStore;
let createListener;
let createMcpHandler;
let createOAuthServer;
let createOAuthStore;
let renderTunnelConfig;
let buildRunArgv;
let reapOrphans;
let isOwnedTunnelRow;
let parsePsRows;
let surfaceHash;
let SURFACE_PIN;
let TOOLS_LIST;
let exchange;

async function loadLocalModules() {
  const [audit, constants, cimd, engine, httpBridge, laneStore, listener, mcp, oauth, oauthStore, tunnelConfig, tunnelReap, tunnelPs, tools, fakeHttp] = await Promise.all([
    import('../../electron/ipc/handoffBridge/audit.js'),
    import('../../electron/ipc/handoffBridge/constants.js'),
    import('../../electron/ipc/handoffBridge/cimd.js'),
    import('../../electron/ipc/handoffBridge/engine.js'),
    import('../../electron/ipc/handoffBridge/http.js'),
    import('../../electron/ipc/handoffBridge/laneStore.js'),
    import('../../electron/ipc/handoffBridge/listener.js'),
    import('../../electron/ipc/handoffBridge/mcp.js'),
    import('../../electron/ipc/handoffBridge/oauth.js'),
    import('../../electron/ipc/handoffBridge/oauthStore.js'),
    import('../../electron/ipc/handoffBridge/tunnel/config.js'),
    import('../../electron/ipc/handoffBridge/tunnel/reap.js'),
    import('../../electron/ipc/handoffBridge/tunnel/psParse.js'),
    import('../../electron/ipc/handoffBridge/tools.js'),
    import('../../scripts/tests/fixtures/handoff-bridge/fakeHttp.js'),
  ]);
  ({ createAuditSink } = audit);
  ({ CONSTANTS } = constants);
  ({ validateClientMetadata } = cimd);
  ({ createHandoffEngine } = engine);
  ({ createRequestHandler } = httpBridge);
  ({ createLaneStore } = laneStore);
  ({ createListener } = listener);
  ({ createMcpHandler } = mcp);
  ({ createOAuthServer } = oauth);
  ({ createOAuthStore } = oauthStore);
  ({ renderTunnelConfig, buildRunArgv } = tunnelConfig);
  ({ reapOrphans } = tunnelReap);
  ({ isOwnedTunnelRow, parsePsRows } = tunnelPs);
  ({ surfaceHash, SURFACE_PIN, TOOLS_LIST } = tools);
  ({ exchange } = fakeHttp);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUITES = Object.freeze(['wire', 'oauth', 'drain', 'push', 'abuse', 'soak', 'tunnel', 'orphan']);
const HOST = 'bridge.example.com';
const ISSUER = 'https://' + HOST;
const RESOURCE = ISSUER + '/mcp';
const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const JOB_ADA = '11111111-1111-4111-8111-111111111111';
const JOB_MARISOL = '22222222-2222-4222-8222-222222222222';
const META_PATH = path.join(ROOT, 'scripts/tests/fixtures/handoff-bridge/chatgpt-client-metadata.json');
const TOOLS_GOLDEN_PATH = path.join(ROOT, 'scripts/tests/fixtures/handoff-bridge/tools-list.v2s.oauth.golden.json');
const WIRE_GOLDEN_DIR = path.join(ROOT, 'scripts/tests/fixtures/handoff-bridge/goldens');
// Keep this allow-list literal and closed: an explicit capture is permitted to
// replace these wire fixtures, never the tool or directive source goldens.
const WIRE_GOLDEN_PATHS = Object.freeze({
  discover: path.join(WIRE_GOLDEN_DIR, 'discover.golden.json'),
  initialize: path.join(WIRE_GOLDEN_DIR, 'initialize.golden.json'),
  notification: path.join(WIRE_GOLDEN_DIR, 'notification.golden.json'),
});
const WIRE_GOLDEN_NAMES = Object.freeze(['discover', 'initialize', 'notification']);
const TEST_SOAK_ENV = 'IC_HANDOFF_BRIDGE_CONFORMANCE_TEST';
// Keep this exhaustive rather than relying on dns.resolve's rrtype argument:
// applications can call a type-specific resolver directly.  Some entries are
// conditional so the guard remains usable on every supported Node 22 build.
const DNS_GUARDED_APIS = Object.freeze([
  'lookup', 'lookupService',
  'getDefaultResultOrder', 'setDefaultResultOrder', 'getServers', 'setServers',
  'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
  'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa',
  'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse',
]);
const DNS_RESOLVER_GUARDED_APIS = Object.freeze([
  'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
  'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa',
  'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse',
]);

function die(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

// This harness may exercise a real Unix-domain listener, but it must never
// resolve or connect to a network endpoint.  Keep a record even when a
// caller catches the denial: the enclosing run fails on any attempt.
function installOutboundEgressGuard() {
  const attempts = [];
  let unixRoot = null;
  const failure = api => {
    attempts.push(api);
    const error = new Error('Conformance outbound egress denied (' + api + '); AF_UNIX sockets only');
    error.code = 'ERR_IC_CONFORMANCE_EGRESS';
    throw error;
  };
  const unixConnect = args => {
    const first = args[0];
    if (Array.isArray(first)) return unixConnect(first);
    if (typeof first === 'string') return Boolean(unixRoot) && path.isAbsolute(first) && under(unixRoot, path.resolve(first));
    if (!first || typeof first !== 'object') return false;
    return ['path', 'socketPath', 'pipeName'].some(key => typeof first[key] === 'string'
      && path.isAbsolute(first[key])
      && Boolean(unixRoot)
      && under(unixRoot, path.resolve(first[key])));
  };
  const unixHttp = args => args.some(value => value && typeof value === 'object'
    && typeof value.socketPath === 'string'
    && path.isAbsolute(value.socketPath)
    && Boolean(unixRoot)
    && under(unixRoot, path.resolve(value.socketPath)));
  const original = {
    createConnection: net.createConnection,
    connect: net.connect,
    socketConnect: net.Socket.prototype.connect,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    tlsConnect: tls.connect,
    dgramCreateSocket: dgram.createSocket,
    fetch: globalThis.fetch,
  };
  const dnsOriginal = [];
  const guardDnsObject = (namespace, prefix, names) => {
    for (const name of names) {
      if (typeof namespace[name] !== 'function') continue;
      dnsOriginal.push({ namespace, name, value: namespace[name] });
      namespace[name] = function guardedDnsApi() { return failure(prefix + '.' + name); };
    }
  };
  const guardDnsResolver = (Resolver, prefix) => {
    if (!Resolver || !Resolver.prototype) return;
    guardDnsObject(Resolver.prototype, prefix, DNS_RESOLVER_GUARDED_APIS);
  };

  net.createConnection = function guardedCreateConnection(...args) {
    if (!unixConnect(args)) return failure('net.createConnection');
    return original.createConnection.apply(this, args);
  };
  net.connect = function guardedConnect(...args) {
    if (!unixConnect(args)) return failure('net.connect');
    return original.connect.apply(this, args);
  };
  net.Socket.prototype.connect = function guardedSocketConnect(...args) {
    if (!unixConnect(args)) return failure('net.Socket.connect');
    return original.socketConnect.apply(this, args);
  };
  http.request = function guardedHttpRequest(...args) {
    if (!unixHttp(args)) return failure('http.request');
    return original.httpRequest.apply(this, args);
  };
  http.get = function guardedHttpGet(...args) {
    if (!unixHttp(args)) return failure('http.get');
    return original.httpGet.apply(this, args);
  };
  https.request = function guardedHttpsRequest(...args) {
    if (!unixHttp(args)) return failure('https.request');
    return original.httpsRequest.apply(this, args);
  };
  https.get = function guardedHttpsGet(...args) {
    if (!unixHttp(args)) return failure('https.get');
    return original.httpsGet.apply(this, args);
  };
  tls.connect = function guardedTlsConnect(...args) {
    if (!unixConnect(args)) return failure('tls.connect');
    return original.tlsConnect.apply(this, args);
  };
  dgram.createSocket = function guardedDgramCreateSocket() { return failure('dgram.createSocket'); };
  guardDnsObject(dns, 'dns', DNS_GUARDED_APIS);
  guardDnsObject(dns.promises, 'dns.promises', DNS_GUARDED_APIS);
  guardDnsResolver(dns.Resolver, 'dns.Resolver');
  guardDnsResolver(dns.promises.Resolver, 'dns.promises.Resolver');
  globalThis.fetch = function guardedFetch() { return failure('fetch'); };

  return Object.freeze({
    attempts: () => attempts.slice(),
    allowUnixRoot(value) {
      const resolved = path.resolve(value);
      const temporary = fs.realpathSync(os.tmpdir());
      const ancestor = existingAncestor(resolved);
      assert.ok(ancestor && under(temporary, fs.realpathSync(ancestor)), 'conformance Unix root must stay below os.tmpdir()');
      unixRoot = resolved;
    },
    restore() {
      net.createConnection = original.createConnection;
      net.connect = original.connect;
      net.Socket.prototype.connect = original.socketConnect;
      http.request = original.httpRequest;
      http.get = original.httpGet;
      https.request = original.httpsRequest;
      https.get = original.httpsGet;
      tls.connect = original.tlsConnect;
      dgram.createSocket = original.dgramCreateSocket;
      for (const entry of dnsOriginal.reverse()) entry.namespace[entry.name] = entry.value;
      globalThis.fetch = original.fetch;
    },
  });
}

function help() {
  return [
    'Usage: node scripts/handoff-bridge-conformance.js --suite=<wire|oauth|drain|push|abuse|soak|tunnel|orphan|all>',
    '       [--capture-goldens] [--lab-diff] [--user-data=<tmp/ic-b-* directory>]',
    '',
    'soak is exactly 600000 ms. Development may shorten it only with ' + TEST_SOAK_ENV + '=1 --soak-ms=<positive milliseconds>.',
  ].join('\n');
}

function args(argv) {
  const result = { suite: 'all', capture: false, lab: false, userData: null, soakMs: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const consume = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) die('Missing value for ' + value);
      index += 1;
      return next;
    };
    if (value === '--help' || value === '-h') return { ...result, help: true };
    if (value === '--capture-goldens') { result.capture = true; continue; }
    if (value === '--lab' || value === '--lab-diff' || value === '--lab=diff') {
      if (value === '--lab' && argv[index + 1] === 'diff') index += 1;
      result.lab = true;
      continue;
    }
    if (value === '--suite') { result.suite = consume(); continue; }
    if (value.startsWith('--suite=')) { result.suite = value.slice(8); continue; }
    if (value === '--user-data') { result.userData = consume(); continue; }
    if (value.startsWith('--user-data=')) { result.userData = value.slice(12); continue; }
    if (value === '--soak-ms') { result.soakMs = Number(consume()); continue; }
    if (value.startsWith('--soak-ms=')) { result.soakMs = Number(value.slice(10)); continue; }
    die('Unknown option: ' + value);
  }
  if (![...SUITES, 'all'].includes(result.suite)) die('Unknown suite: ' + result.suite);
  if (result.soakMs !== null && (!Number.isSafeInteger(result.soakMs) || result.soakMs < 1)) die('--soak-ms must be a positive integer');
  if (result.soakMs !== null && process.env[TEST_SOAK_ENV] !== '1') die('--soak-ms is test-only; set ' + TEST_SOAK_ENV + '=1');
  return result;
}

function under(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function existingAncestor(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function context(options) {
  const tmpLexical = os.tmpdir();
  const tmp = fs.realpathSync(tmpLexical);
  const ownsRoot = options.userData === null;
  const requested = ownsRoot ? fs.mkdtempSync(path.join(tmpLexical, 'ic-b-')) : path.resolve(options.userData);
  // Validate a caller-supplied scratch root before mkdir/chmod can touch it.
  // The real ancestor check rejects a lexical /tmp child that is reached
  // through a symlink into a non-temporary directory.
  if (!ownsRoot) {
    const ancestor = existingAncestor(requested);
    const actualAncestor = ancestor && fs.realpathSync(ancestor);
    if (!under(path.resolve(tmpLexical), requested)
        || !actualAncestor
        || !under(tmp, actualAncestor)
        || !path.basename(requested).startsWith('ic-b-')) {
      die('Refusing userData outside a private os.tmpdir()/ic-b-* directory: ' + requested);
    }
    if (fs.existsSync(requested)) {
      const existing = fs.lstatSync(requested);
      if (!existing.isDirectory() || existing.isSymbolicLink()) die('Refusing unsafe userData directory: ' + requested);
    } else fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(requested, 0o700);
  // Keep the lexical os.tmpdir spelling for the socket. On macOS its realpath
  // can gain `/private`, which would turn an otherwise valid 96-byte socket
  // into an over-limit path. Realpaths are still used for every containment
  // decision below.
  const root = requested;
  const actualRoot = fs.realpathSync(requested);
  const stat = fs.lstatSync(requested);
  if (!under(tmp, actualRoot) || !path.basename(root).startsWith('ic-b-') || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    die('Refusing userData outside a private os.tmpdir()/ic-b-* directory: ' + actualRoot);
  }
  let count = 0;
  const children = [];
  return {
    root,
    make(label) {
      const name = String(label).replace(/[^a-z0-9-]/gi, '-').slice(0, 30) || 'run';
      const target = path.join(root, name + '-' + (++count));
      fs.mkdirSync(target, { mode: 0o700 });
      fs.chmodSync(target, 0o700);
      const actual = fs.realpathSync(target);
      if (!under(tmp, actual) || !under(actualRoot, actual)) die('unsafe generated userData');
      children.push(target);
      return target;
    },
    cleanup() {
      for (const child of children.reverse()) {
        try { fs.rmSync(child, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      if (ownsRoot) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function socketPath(userData) {
  const value = path.join(userData, 'handoff-bridge', 'b.sock');
  assert.ok(under(userData, value), 'socket leaves userData');
  assert.ok(Buffer.byteLength(value, 'utf8') <= 100, 'socket path is over 100 bytes: ' + Buffer.byteLength(value, 'utf8') + ' ' + value);
  return value;
}

function randomBytes(start = 1) {
  let value = start;
  return count => Buffer.alloc(count, value++ & 0xff);
}

function store() {
  let state = { v: 1, clients: [], codes: [], families: [], refresh: [], access: [] };
  return {
    read: () => JSON.parse(JSON.stringify(state)),
    commit: next => { state = JSON.parse(JSON.stringify(next)); return true; },
    flush: () => true,
  };
}

function appSource() {
  const entries = new Map([
    [JOB_ADA, { code: 'ADA-HANDOFF-001', stage: 'resume', persona: 'Ada Lovelace' }],
    [JOB_MARISOL, { code: 'MARISOL-HANDOFF-002', stage: 'cover-letter', persona: 'Marisol Quenby' }],
  ]);
  const submitted = [];
  let reject = false;
  return {
    submitted,
    rejectNext() { reject = true; },
    replaceCode(jobId, code) {
      const item = entries.get(jobId);
      assert.ok(item && typeof code === 'string' && code.length > 0, 'synthetic source can rotate only a known handoff code');
      item.code = code;
    },
    api: {
      async read({ jobId }) {
        const item = entries.get(jobId) || entries.get(JOB_ADA);
        return { kind: 'open', handoff: { code: item.code, jobId, stage: item.stage, revision: reject ? 2 : 1, prompt: 'Synthetic ' + item.stage + ' for ' + item.persona + ' at Example Systems.' } };
      },
      async status() { return { kind: 'host' }; },
      async submit({ jobId }, { code: handoffCode, text: response } = {}) {
        submitted.push({ jobId, handoffCode, response });
        if (reject) {
          reject = false;
          return {
            kind: 'rejected',
            handoff: { code: handoffCode + '-CORRECTED', jobId, stage: 'resume', revision: 2, prompt: 'Correct the synthetic date.' },
            validationErrors: ['Synthetic correction required.'],
          };
        }
        return { kind: 'accepted', completed: true };
      },
    },
  };
}

function json(bytes) {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return null; }
}

function toolGoldenBytes(tools) {
  return Buffer.from(JSON.stringify(tools, null, 2) + '\n', 'utf8');
}

function assertToolGolden(tools) {
  const expected = fs.readFileSync(TOOLS_GOLDEN_PATH);
  const actual = toolGoldenBytes(tools);
  assert.ok(actual.equals(expected), 'tool surface bytes drifted from tools-list.v2s.oauth.golden.json; refresh the ChatGPT plugin only after an intentional golden update');
}

function headers(values = {}) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function requestSocket(sock, input = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: sock,
      method: input.method || 'GET',
      path: input.path || '/',
      headers: { host: HOST, connection: 'close', ...(input.headers || {}) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode || 0, headers: headers(response.headers), body: Buffer.concat(chunks) }));
    });
    request.once('error', reject);
    request.setTimeout(input.timeoutMs || 5000, () => request.destroy(new Error('Unix socket request timed out')));
    if (input.body !== undefined && input.body !== null && input.body !== '') request.write(input.body);
    request.end();
  });
}

function rawSocket(sock, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: sock });
    const chunks = [];
    let done = false;
    let timer;
    const settle = error => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    client.once('connect', () => client.end(payload));
    client.on('data', chunk => chunks.push(Buffer.from(chunk)));
    client.once('error', settle);
    client.once('end', () => settle());
    timer = setTimeout(() => { client.destroy(); settle(new Error('raw Unix socket request timed out')); }, timeoutMs);
    timer.unref?.();
  });
}

function slowRawSocket(sock, head, chunks, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: sock });
    const received = [];
    let done = false;
    let timer;
    const finish = error => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve(Buffer.concat(received));
    };
    client.once('connect', async () => {
      try {
        client.write(head);
        for (const chunk of chunks) {
          await delay(15);
          client.write(chunk);
        }
        client.end();
      } catch (error) { client.destroy(); finish(error); }
    });
    client.on('data', chunk => received.push(Buffer.from(chunk)));
    client.once('error', finish);
    client.once('end', () => finish());
    timer = setTimeout(() => { client.destroy(); finish(new Error('slow raw Unix socket request timed out')); }, timeoutMs);
    timer.unref?.();
  });
}

function statuses(raw) {
  return [...Buffer.from(raw).toString('latin1').matchAll(/HTTP\/1\.1 (\d{3})/g)].map(item => Number(item[1]));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function bytes(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  if (typeof value.arrayBuffer === 'function') return Buffer.from(await value.arrayBuffer());
  if (value[Symbol.asyncIterator]) {
    const chunks = [];
    for await (const chunk of value) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(value));
}

function localFetch(sock) {
  return async (input, init = {}) => {
    const source = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const target = new URL(source);
    if (target.protocol !== 'https:' || target.hostname !== HOST || target.port || target.pathname !== '/mcp') {
      throw new TypeError('SDK fetch is restricted to the local protected-resource socket');
    }
    const requestHeaders = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
    requestHeaders.set('host', HOST);
    const response = await requestSocket(sock, {
      method: init.method || (typeof input === 'object' ? input.method : undefined) || 'GET',
      path: target.pathname + target.search,
      headers: Object.fromEntries(requestHeaders.entries()),
      body: await bytes(init.body),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

function form(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== null)).toString();
}

function pkce() {
  const verifier = crypto.createHash('sha256').update('Ada Lovelace conformance verifier').digest('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function fixture(ctx, label, wantsEngine = false, engineOptions = {}) {
  // A restart deliberately reuses this directory, but always builds fresh
  // listener/OAuth/engine objects around it.  Every other fixture owns a new
  // private child as before.
  const userData = engineOptions.userData || ctx.make(label);
  const bridgeDir = path.join(userData, 'handoff-bridge');
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(bridgeDir, 0o700);
  const sock = socketPath(userData);
  const metadata = validateClientMetadata(JSON.parse(fs.readFileSync(META_PATH, 'utf8')), CLIENT_ID);
  assert.ok(metadata, 'checked-in ChatGPT metadata fixture must validate');
  const oauth = createOAuthServer({
    issuer: ISSUER,
    store: engineOptions.oauthStore || store(),
    randomBytes: randomBytes(),
    fetchClientMetadata: async clientId => clientId === CLIENT_ID ? metadata : null,
    fetchJwks: async () => null,
    tokenAuthMode: 'observe-both',
    asAuthMethods: ['none'],
  });
  const source = engineOptions.source || appSource();
  const engine = wantsEngine ? createHandoffEngine({
    source: source.api,
    store: engineOptions.store,
    audit: engineOptions.audit,
    random: engineOptions.random || randomBytes(),
    holdMs: engineOptions.holdMs ?? 25,
    submitBudgetMs: engineOptions.submitBudgetMs ?? 25000,
    restoredLanes: engineOptions.restoredLanes,
    confirmRestart: engineOptions.confirmRestart,
  }) : null;
  const mcp = createMcpHandler({
    port: engine ? { get: value => engine.get(value), submit: value => engine.submit(value) } : {
      get: async () => ({ status: 'queue_empty', note: 'No synthetic handoff is waiting.' }),
      submit: async value => ({ status: 'accepted', echoedBytes: Buffer.byteLength(value.response, 'utf8') }),
    },
  });
  const handler = createRequestHandler({ hostname: HOST, oauth, mcp, sourcePolicy: 'off' });
  const listener = createListener({ socketPath: sock, handler });
  await listener.start();
  let closed = false;
  return {
    userData, sock, oauth, source, engine, handler,
    direct: async input => {
      const result = await exchange(handler, {
        method: input.method || 'GET', path: input.path || '/', headers: input.headers || {}, body: input.body || '',
        chunked: input.chunked === true, chunkSize: input.chunkSize || 0,
      });
      return { status: result.status, headers: headers(result.headers), body: Buffer.from(result.body) };
    },
    socket: input => requestSocket(sock, input),
    async close() {
      if (closed) return;
      closed = true;
      try { await engine?.close?.(); } catch { /* best effort */ }
      try { oauth.close(); } catch { /* memory-only state */ }
      try { await listener.stop(); } catch { /* socket unlink below */ }
      try { fs.unlinkSync(sock); } catch { /* already unlinked */ }
    },
  };
}

function assertTokenPayload(value, label) {
  assert.match(value?.access_token || '', /^[A-Za-z0-9_-]{43}$/, label + ' access token is malformed');
  assert.match(value?.refresh_token || '', /^[A-Za-z0-9_-]{43}$/, label + ' refresh token is malformed');
  assert.equal(value?.token_type, 'Bearer', label + ' token type drifted');
  assert.equal(value?.expires_in, 3600, label + ' access lifetime drifted');
  assert.equal(value?.scope, 'handoff', label + ' token scope drifted');
}

async function link(env, request, { record = null } = {}) {
  const note = (step, result) => { record?.(step, result); return result; };
  const pairing = env.oauth.openPairing();
  assert.match(String(pairing), /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
  const proof = pkce();
  const page = note('authorize.page', await request({
    method: 'GET',
    path: '/oauth/authorize?' + form({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: 'ada-state',
      code_challenge: proof.challenge, code_challenge_method: 'S256', resource: RESOURCE, scope: 'handoff offline_access',
    }),
  }));
  assert.equal(page.status, 200, 'authorization page must be armed');
  const txn = /name="txn" value="([^"]+)"/.exec(page.body.toString('utf8'))?.[1];
  assert.ok(txn, 'authorization transaction missing');
  const approved = note('authorize.approve', await request({
    method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ txn, action: 'approve', pairing_code: pairing }),
  }));
  assert.equal(approved.status, 302, 'pairing confirmation must redirect');
  const code = new URL(approved.headers.location).searchParams.get('code');
  assert.match(code || '', /^[A-Za-z0-9_-]{43}$/, 'authorization redirect omitted a usable code');
  const token = note('token.authorization_code', await request({
    method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: proof.verifier, resource: RESOURCE, client_id: CLIENT_ID }),
  }));
  assert.equal(token.status, 200, 'authorization-code exchange must succeed');
  const value = json(token.body);
  assertTokenPayload(value, 'authorization-code exchange');
  return value;
}

async function refresh(request, token, extraHeaders = {}, { record = null, step = 'token.refresh' } = {}) {
  const result = await request({
    method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: form({ grant_type: 'refresh_token', refresh_token: token.refresh_token, resource: RESOURCE, client_id: CLIENT_ID }),
  });
  record?.(step, result);
  assert.equal(result.status, 200, 'refresh must succeed');
  const value = json(result.body);
  assertTokenPayload(value, 'refresh');
  assert.notEqual(value.access_token, token.access_token, 'refresh must rotate the access token');
  assert.notEqual(value.refresh_token, token.refresh_token, 'refresh must rotate the refresh token');
  return value;
}

function normalizeTranscriptHeaders(values = {}) {
  const omitted = new Set(['connection', 'date', 'keep-alive', 'transfer-encoding']);
  const output = {};
  for (const key of Object.keys(values).map(value => value.toLowerCase()).sort()) {
    if (omitted.has(key) || values[key] === undefined) continue;
    let value = String(values[key]);
    if (key === 'location') value = value.replace(/([?&]code=)[^&]*/u, '$1<authorization_code>');
    output[key] = value;
  }
  return output;
}

function normalizeTranscriptJson(value) {
  if (Array.isArray(value)) return value.map(normalizeTranscriptJson);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = ['access_token', 'refresh_token', 'code'].includes(key)
      ? '<' + key + '>'
      : normalizeTranscriptJson(child);
  }
  return output;
}

function normalizeTranscriptText(value) {
  return String(value).replace(/(name="txn" value=")[^"]+("?)/u, '$1<transaction>$2');
}

function summary(result) {
  const parsed = json(result.body);
  const headers = normalizeTranscriptHeaders(result.headers);
  if (!parsed || typeof parsed !== 'object') return { status: result.status, headers, text: normalizeTranscriptText(result.body.toString('utf8')) };
  return { status: result.status, headers, body: normalizeTranscriptJson(parsed) };
}

function transcriptRow(rows, step) {
  const row = rows.find(item => item.step === step);
  assert.ok(row, 'OAuth transcript omitted ' + step);
  return row;
}

function assertTranscriptHeaders(rows) {
  const protectedResource = transcriptRow(rows, 'protected_resource');
  assert.equal(protectedResource.headers['cache-control'], 'no-store', 'protected-resource cache policy drifted');
  assert.equal(protectedResource.headers.pragma, 'no-cache', 'protected-resource pragma drifted');
  assert.equal(protectedResource.headers['content-type'], 'application/json; charset=utf-8', 'protected-resource content type drifted');
  assert.equal(protectedResource.headers['x-content-type-options'], 'nosniff', 'protected-resource nosniff header drifted');

  const page = transcriptRow(rows, 'authorize.page');
  assert.equal(page.headers['cache-control'], 'no-store', 'authorize page cache policy drifted');
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8', 'authorize page content type drifted');
  assert.equal(page.headers['x-frame-options'], 'DENY', 'authorize page framing header drifted');
  assert.equal(page.headers['referrer-policy'], 'no-referrer', 'authorize page referrer policy drifted');
  assert.match(page.headers['content-security-policy'] || '', /default-src 'none'/u, 'authorize page CSP drifted');

  const approved = transcriptRow(rows, 'authorize.approve');
  assert.equal(approved.headers['cache-control'], 'no-store', 'authorize redirect cache policy drifted');
  assert.equal(approved.headers['referrer-policy'], 'no-referrer', 'authorize redirect referrer policy drifted');
  assert.equal(approved.headers['x-content-type-options'], 'nosniff', 'authorize redirect nosniff header drifted');
  assert.match(approved.headers.location || '', /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect\?code=<authorization_code>&state=ada-state&iss=https%3A%2F%2Fbridge\.example\.com$/u, 'authorize redirect location drifted');

  for (const step of ['token.authorization_code', 'token.refresh', 'token.refresh.invalid']) {
    const row = transcriptRow(rows, step);
    assert.equal(row.headers['cache-control'], 'no-store', step + ' cache policy drifted');
    assert.equal(row.headers.pragma, 'no-cache', step + ' pragma drifted');
    assert.equal(row.headers['content-type'], 'application/json; charset=utf-8', step + ' content type drifted');
    assert.equal(row.headers['x-content-type-options'], 'nosniff', step + ' nosniff header drifted');
  }
}

async function transcript(ctx, label, mode) {
  const env = await fixture(ctx, label);
  try {
    const request = mode === 'socket' ? env.socket : env.direct;
    const rows = [];
    const record = (step, result) => rows.push({ step, ...summary(result) });
    record('protected_resource', await request({ method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' }));
    const unarmed = await request({ method: 'GET', path: '/oauth/authorize?' + form({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, resource: RESOURCE }) });
    assert.equal(unarmed.status, 403, 'unarmed authorize must stay closed');
    record('authorize.unarmed', unarmed);
    const token = await link(env, request, { record });
    const list = await request({
      method: 'POST', path: '/mcp', headers: { authorization: 'Bearer ' + token.access_token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    assert.equal(list.status, 200, 'tools/list must succeed');
    const tools = json(list.body)?.result?.tools;
    assert.deepEqual(tools, TOOLS_LIST, 'tool list drifted');
    assertToolGolden(tools);
    record('mcp.tools_list.initial_access', list);
    const refreshed = await refresh(request, token, {}, { record });
    const oldAccess = await request({
      method: 'POST', path: '/mcp', headers: { authorization: 'Bearer ' + token.access_token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
    });
    assert.equal(oldAccess.status, 200, 'pre-refresh access token must retain its valid lifetime');
    record('mcp.tools_list.previous_access', oldAccess);
    const refreshedAccess = await request({
      method: 'POST', path: '/mcp', headers: { authorization: 'Bearer ' + refreshed.access_token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    assert.equal(refreshedAccess.status, 200, 'refreshed access token must authenticate MCP');
    record('mcp.tools_list.refreshed_access', refreshedAccess);
    const invalid = await request({
      method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: 'not-a-real-refresh', resource: RESOURCE, client_id: CLIENT_ID }),
    });
    assert.equal(invalid.status, 400, 'invalid refresh must fail closed');
    record('token.refresh.invalid', invalid);
    assertTranscriptHeaders(rows);
    return { rows };
  } finally { await env.close(); }
}

async function sdk() {
  try {
    const loaded = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('zod'),
    ]);
    if (typeof loaded[0].Client !== 'function' || typeof loaded[1].StreamableHTTPClientTransport !== 'function' || !loaded[2].z) throw new Error('wrong SDK dependency shape');
    return { Client: loaded[0].Client, Transport: loaded[1].StreamableHTTPClientTransport };
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package|Cannot find module/.test(String(error?.message))) {
      die('Conformance dependencies are missing. Run: npm install --prefix scripts/handoff-bridge-conformance', 2);
    }
    throw error;
  }
}

async function withSdkClient(env, loaded, token, operation) {
  let client;
  let transport;
  try {
    transport = new loaded.Transport(new URL(RESOURCE), {
      fetch: localFetch(env.sock),
      authProvider: { tokens: async () => ({ access_token: token.access_token }) },
    });
    client = new loaded.Client({ name: 'ic-conformance', version: '1.0.0' });
    await client.connect(transport);
    return await operation(client);
  } finally {
    try { await client?.close?.(); } catch { /* idempotent */ }
    try { await transport?.close?.(); } catch { /* idempotent */ }
  }
}

function sdkToolBody(result, label) {
  const text = result?.content?.find?.(item => item?.type === 'text')?.text;
  assert.equal(typeof text, 'string', label + ' did not return a text tool result');
  const body = json(text);
  assert.ok(body && typeof body === 'object', label + ' returned non-JSON tool content');
  return body;
}

async function callSdkTool(client, name, arguments_, label) {
  return sdkToolBody(await client.callTool({ name, arguments: arguments_ }), label || name);
}

async function sdkSocket(ctx, loaded) {
  const env = await fixture(ctx, 'sdk', true);
  try {
    const token = await link(env, env.socket);
    const grant = env.oauth.authenticate({ headers: { authorization: 'Bearer ' + token.access_token } });
    assert.equal((await env.engine.release({ jobs: [{ jobId: JOB_ADA, canvasFilePath: '/tmp/ic-b-sdk.canvas' }] })).ok, true, 'SDK fixture release failed');
    const chat = await env.engine.newChat({ linkId: grant.linkId });
    assert.equal(chat.copied, true, 'SDK fixture chat creation failed');
    await withSdkClient(env, loaded, token, async client => {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools, TOOLS_LIST, 'SDK custom fetch did not use the Unix socket correctly');
      const served = await callSdkTool(client, 'get_handoff', { session: chat.sessionCode }, 'SDK get_handoff');
      assert.equal(served.status, 'served', 'SDK get_handoff did not reach the engine over the Unix socket');
      const response = answer(JOB_ADA, served.handoffCode, '', served.stage);
      const submitted = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode, handoffCode: served.handoffCode, response,
      }, 'SDK submit_handoff');
      assert.equal(submitted.status, 'accepted', 'SDK submit_handoff did not complete against the engine over the Unix socket');
      assert.equal(env.source.submitted.at(-1)?.response, response, 'SDK submit_handoff changed bytes before the application source');
    });
  } finally {
    await env.close();
  }
}

function staticLabDiff() {
  const output = {};
  for (const name of ['oauth.js', 'server.js', 'design-tools.js']) {
    const target = path.join(ROOT, 'scripts/chatgpt-handoff-spike', name);
    output[name] = fs.existsSync(target)
      ? crypto.createHash('sha256').update(fs.readFileSync(target, 'utf8')).digest('hex').slice(0, 16)
      : 'absent';
  }
  assert.ok(Object.values(output).every(value => /^[0-9a-f]{16}$/.test(value)), 'static lab diff source is missing or unreadable');
  // Hashes alone merely say that a lab file changed.  Compare the frozen
  // artifacts without importing the lab (which has process/env side effects):
  // the current production surface is already byte-pinned above, and these
  // literal checks prove that the lab's v2s wording and directive corpus still
  // carry that same frozen material.
  const toolsSource = fs.readFileSync(path.join(ROOT, 'scripts/chatgpt-handoff-spike', 'design-tools.js'), 'utf8');
  const directiveSource = fs.readFileSync(path.join(ROOT, 'scripts/chatgpt-handoff-spike', 'realistic.js'), 'utf8');
  const goldenTools = JSON.parse(fs.readFileSync(TOOLS_GOLDEN_PATH, 'utf8'));
  const directive = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/tests/fixtures/handoff-bridge/notes-instructions.directive.golden.json'), 'utf8'));
  const toolStrings = goldenTools.flatMap(tool => [tool.title, tool.description, ...Object.values(tool.inputSchema?.properties || {}).map(value => value?.description)]).filter(value => typeof value === 'string' && value.length > 0);
  const directiveStrings = [directive.instructions, ...Object.entries(directive.notes || {})
    .filter(([name]) => name !== 'correction' && name !== 'supersededStage').map(([, value]) => value)];
  assert.ok(toolStrings.every(value => toolsSource.includes(value)), 'lab tool source no longer contains a frozen v2s tool artifact');
  assert.ok(directiveStrings.every(value => directiveSource.includes(value)), 'lab directive source no longer contains a frozen directive artifact');
  assert.ok(directiveSource.includes('complete corrected ${stage} response') && directiveSource.includes('(handoffCode ${code})'),
    'lab directive source no longer has the frozen correction directive template');
  console.log('static lab diff (no import/spawn; frozen artifacts compared): ' + JSON.stringify({ ...output, toolStrings: toolStrings.length, directiveStrings: directiveStrings.length }));
}

function canonicalRawWire(raw, label) {
  // Golden the on-the-wire HTTP/1.1 response, not an IncomingMessage's
  // reconstruction of it. Only Date's value is volatile. Preserve the status
  // line and every other byte, including header order/case/whitespace and
  // Connection, in the base64 representation below.
  const bytes_ = Buffer.from(raw);
  const split = bytes_.indexOf(Buffer.from('\r\n\r\n'));
  assert.ok(split >= 0, label + ' did not contain a complete HTTP response head');
  const lines = bytes_.subarray(0, split).toString('latin1').split('\r\n');
  const statusLine = lines.shift() || '';
  const match = /^HTTP\/1\.1 (\d{3}) [^\r\n]+$/u.exec(statusLine);
  assert.ok(match, label + ' did not use canonical HTTP/1.1 status framing');
  const rawHeaders = {};
  const canonicalLines = [statusLine];
  for (const line of lines) {
    const at = line.indexOf(':');
    assert.ok(at > 0, label + ' has malformed response header framing');
    const key = line.slice(0, at).toLowerCase();
    assert.ok(!Object.hasOwn(rawHeaders, key), label + ' repeated response header ' + key);
    rawHeaders[key] = line.slice(at + 1).trim();
    if (key !== 'date') canonicalLines.push(line);
    else {
      // Replace the value only; header spelling and its exact post-colon
      // whitespace remain part of the raw fixture.
      const whitespace = /^[ \t]*/u.exec(line.slice(at + 1))?.[0] || '';
      canonicalLines.push(line.slice(0, at + 1) + whitespace + '<date>');
    }
  }
  const body = bytes_.subarray(split + 4);
  const length = Number(rawHeaders['content-length'] || 0);
  assert.equal(body.length, length, label + ' raw body length disagrees with Content-Length');
  const canonical = Buffer.concat([Buffer.from(canonicalLines.join('\r\n') + '\r\n\r\n', 'latin1'), body]);
  return { status: Number(match[1]), rawHttp11Base64: canonical.toString('base64') };
}

function wireGoldenBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function wireGoldenPath(name) {
  const target = WIRE_GOLDEN_PATHS[name];
  assert.ok(WIRE_GOLDEN_NAMES.includes(name) && typeof target === 'string' && path.dirname(target) === WIRE_GOLDEN_DIR,
    'wire capture target is not in the closed fixture allow-list: ' + String(name));
  return target;
}

function atomicWriteWireGolden(name, value) {
  const target = wireGoldenPath(name);
  const directory = path.dirname(target);
  const directoryStat = fs.lstatSync(directory);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'wire golden directory is unsafe: ' + directory);
  if (fs.existsSync(target)) {
    const existing = fs.lstatSync(target);
    assert.ok(existing.isFile() && !existing.isSymbolicLink(), 'wire golden target is unsafe: ' + target);
  }
  const bytes = wireGoldenBytes(value);
  const temporary = path.join(directory, '.' + path.basename(target) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // Same-directory rename is the commit point. The capture operation never
    // writes tool/directive goldens or any caller-selected path.
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    try {
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch { /* the file itself was synced before rename */ }
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* cleanup only */ }
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* cleanup only */ }
  }
}

function assertWireGoldens(capture) {
  for (const name of WIRE_GOLDEN_NAMES) {
    const target = wireGoldenPath(name);
    let expected;
    try { expected = fs.readFileSync(target); }
    catch { assert.fail('missing checked-in wire fixture: ' + target + '; run --suite=wire --capture-goldens to capture only the three wire fixtures'); }
    const actual = wireGoldenBytes(capture[name]);
    assert.ok(actual.equals(expected), 'wire ' + name + ' bytes drifted from ' + path.relative(ROOT, target) + '; inspect and use --suite=wire --capture-goldens for an intentional update');
  }
}

function captureWireFixtures(capture) {
  for (const name of WIRE_GOLDEN_NAMES) atomicWriteWireGolden(name, capture[name]);
}

async function captureWireGoldens(ctx) {
  const env = await fixture(ctx, 'wire-capture');
  try {
    const token = await link(env, env.socket);
    const rawRequest = (method, requestPath, requestHeaders = {}, body = '') => {
      const text = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      const merged = { Host: HOST, Connection: 'close', ...requestHeaders, 'Content-Length': String(text.length) };
      return Buffer.concat([Buffer.from(method + ' ' + requestPath + ' HTTP/1.1\r\n' + Object.entries(merged).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n', 'latin1'), text]);
    };
    const discover = canonicalRawWire(await rawSocket(env.sock, rawRequest('GET', '/.well-known/oauth-protected-resource/mcp')), 'capture discovery');
    const initializeBody = JSON.stringify({ jsonrpc: '2.0', id: 'capture-initialize', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ic-conformance', version: '1.0.0' } } });
    const initialize = canonicalRawWire(await rawSocket(env.sock, rawRequest('POST', '/mcp', { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json' }, initializeBody)), 'capture initialize');
    const notificationBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const notification = canonicalRawWire(await rawSocket(env.sock, rawRequest('POST', '/mcp', { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json' }, notificationBody)), 'capture notification');
    assert.equal(discover.status, 200, 'capture discovery failed');
    assert.equal(initialize.status, 200, 'capture initialize failed');
    assert.equal(notification.status, 202, 'capture notification failed');
    return { discover, initialize, notification };
  } finally { await env.close(); }
}

async function wire(ctx, options, loaded) {
  assert.equal(surfaceHash(), SURFACE_PIN, 'surface pin drifted');
  assertToolGolden(TOOLS_LIST);
  const inProcess = await transcript(ctx, 'wire-direct', 'direct');
  const socket = await transcript(ctx, 'wire-socket', 'socket');
  assert.deepEqual(socket.rows, inProcess.rows, 'driver-neutral table differs between in-process and Unix socket');
  await sdkSocket(ctx, loaded);
  const env = await fixture(ctx, 'wire-raw');
  try {
    const normal = await rawSocket(env.sock, 'GET /.well-known/oauth-protected-resource/mcp HTTP/1.1\r\nHost: ' + HOST + '\r\nConnection: close\r\n\r\n');
    assert.deepEqual(statuses(normal), [200], 'raw socket discovery failed');
    const absolute = await rawSocket(env.sock, 'POST http://' + HOST + '/mcp HTTP/1.1\r\nHost: ' + HOST + '\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
    assert.deepEqual(statuses(absolute), [400], 'absolute-form target did not fail closed');
    const overflow = await rawSocket(env.sock, 'GET /.well-known/oauth-protected-resource/mcp HTTP/1.1\r\nHost: ' + HOST + '\r\nX-Long: ' + 'x'.repeat(20480) + '\r\nConnection: close\r\n\r\n');
    assert.deepEqual(statuses(overflow), [431], 'header overflow must be fixed 431');
    const expect = await rawSocket(env.sock, 'POST /mcp HTTP/1.1\r\nHost: ' + HOST + '\r\nExpect: 100-continue\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
    assert.deepEqual(statuses(expect), [401], 'Expect must authenticate before 100 Continue');
    assert.ok(!expect.toString('latin1').includes('100 Continue'), 'unauthenticated Expect was continued');
    const pipelined = await rawSocket(env.sock, 'GET /.well-known/oauth-protected-resource/mcp HTTP/1.1\r\nHost: ' + HOST + '\r\n\r\nGET /.well-known/openid-configuration HTTP/1.1\r\nHost: ' + HOST + '\r\nConnection: close\r\n\r\n');
    assert.deepEqual(statuses(pipelined), [200, 200], 'pipelining lost a response boundary');
    const smuggle = await rawSocket(env.sock, 'POST /oauth/token HTTP/1.1\r\nHost: ' + HOST + '\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\nConnection: close\r\n\r\n0\r\n\r\n');
    assert.deepEqual(statuses(smuggle), [400], 'CL plus TE ambiguity was accepted');
    const slow = await slowRawSocket(env.sock, 'POST /oauth/token HTTP/1.1\r\nHost: ' + HOST + '\r\nTransfer-Encoding: chunked\r\nContent-Type: application/x-www-form-urlencoded\r\nConnection: close\r\n\r\n', ['8\r\ngrant_ty\r\n', '8\r\npe=none\r\n', '0\r\n\r\n']);
    assert.equal(statuses(slow)[0], 400, 'slow chunked OAuth must not become a 5xx');
  } finally { await env.close(); }
  const capture = await captureWireGoldens(ctx);
  if (options.capture) {
    captureWireFixtures(capture);
    console.log('handoff bridge conformance: captured wire fixtures: ' + WIRE_GOLDEN_NAMES.join(', '));
  } else assertWireGoldens(capture);
  if (options.lab) staticLabDiff();
}

async function oauth(ctx, loaded) {
  const direct = await transcript(ctx, 'oauth-direct', 'direct');
  const socket = await transcript(ctx, 'oauth-socket', 'socket');
  assert.deepEqual(socket.rows, direct.rows, 'OAuth response table differs by driver');
  await sdkSocket(ctx, loaded);
}

function answer(jobId, code, padding = '', stage = 'resume') {
  return JSON.stringify({ jobId, stage, handoffCode: code, text: 'Synthetic Ada Lovelace and Marisol Quenby response. '.repeat(8) + padding });
}

function answerWithExactBytes(jobId, code, targetBytes, stage = 'resume') {
  const base = answer(jobId, code, '', stage);
  const paddingBytes = targetBytes - Buffer.byteLength(base, 'utf8');
  assert.ok(Number.isSafeInteger(targetBytes) && paddingBytes >= 0, 'requested synthetic answer is smaller than its required envelope');
  const value = answer(jobId, code, 'R'.repeat(paddingBytes), stage);
  assert.equal(Buffer.byteLength(value, 'utf8'), targetBytes, 'synthetic answer byte count drifted');
  return value;
}

async function assertAbortMidHold() {
  let reads = 0;
  const source = {
    async read() { reads += 1; return { kind: 'host' }; },
    async status() { return { kind: 'host' }; },
    async submit() { return { kind: 'accepted', completed: true }; },
  };
  const engine = createHandoffEngine({ source, random: randomBytes(), holdMs: 1000, submitBudgetMs: 25000 });
  try {
    assert.equal((await engine.release({ jobs: [{ jobId: JOB_ADA, canvasFilePath: '/tmp/ic-b-abort.canvas' }] })).ok, true, 'abort fixture release failed');
    const chat = await engine.newChat({ linkId: 'link-abort' });
    const abort = new AbortController();
    const held = engine.get({ session: chat.sessionCode, linkId: 'link-abort', signal: abort.signal });
    await waitFor(() => engine.debugState().waiters === 1, 500, 'abort-mid-hold did not enter the production hold');
    abort.abort();
    const result = await held;
    assert.equal(result.status, 'retry', 'aborting an active production hold must return retry');
    assert.equal(reads, 1, 'abort-mid-hold must read exactly one lane before waiting');
    assert.equal(engine.debugState().waiters, 0, 'abort-mid-hold leaked a production waiter');
  } finally { await engine.close(); }
}

async function assertRestartMidDrain(ctx, loaded) {
  const userData = ctx.make('drain-restart');
  const source = appSource();
  let first = null;
  let replacement = null;
  try {
    // Build the actual graph that composition owns: lane storage plus a fresh
    // OAuth server, MCP handler, listener and engine.  The only thing shared
    // across the simulated process replacement is data on disk and the fake
    // application source.
    const firstStore = createLaneStore({ userDataPath: userData });
    const oauthStatePath = path.join(userData, 'handoff-bridge', 'oauth-state.json');
    first = await fixture(ctx, 'drain-restart-first', true, {
      userData, source, store: firstStore, oauthStore: createOAuthStore({ filePath: oauthStatePath }),
      holdMs: 15, submitBudgetMs: 25000,
    });
    const firstToken = await link(first, first.socket);
    const firstGrant = first.oauth.authenticate({ headers: { authorization: 'Bearer ' + firstToken.access_token } });
    assert.equal((await first.engine.release({ jobs: [
      { jobId: JOB_ADA, canvasFilePath: '/tmp/ic-b-restart-ada.canvas' },
      { jobId: JOB_MARISOL, canvasFilePath: '/tmp/ic-b-restart-marisol.canvas' },
    ] })).ok, true, 'durable restart fixture must release two jobs');
    const originalChat = await first.engine.newChat({ linkId: firstGrant.linkId });
    let active;
    await withSdkClient(first, loaded, firstToken, async client => {
      active = await callSdkTool(client, 'get_handoff', { session: originalChat.sessionCode }, 'restart first get_handoff');
    });
    assert.equal(active.status, 'served', 'restart fixture must have an active in-flight lane before replacement');
    assert.equal(first.engine.snapshot().queue.jobs.filter(job => job.phase === 'awaiting').length, 1, 'restart fixture did not retain one active lane');
    await firstStore.flush();
    const durableBytes = fs.readFileSync(firstStore.lanesPath, 'utf8');
    assert.ok(!durableBytes.includes(active.handoffCode) && !durableBytes.includes(active.prompt) && !durableBytes.includes(originalChat.sessionCode),
      'production lane store persisted active prompt, code, or chat material');
    const oauthBytes = fs.readFileSync(oauthStatePath, 'utf8');
    assert.ok(!oauthBytes.includes(firstToken.access_token) && !oauthBytes.includes(firstToken.refresh_token),
      'production OAuth store persisted a raw access or refresh token');

    // Closing the complete graph is important: this is not an in-memory
    // engine swap.  The recovered graph gets a new listener and OAuth state.
    await first.close();
    first = null;
    source.replaceCode(JOB_ADA, 'ADA-HANDOFF-RECOVERED-003');
    const replacementStore = createLaneStore({ userDataPath: userData });
    const restoredLanes = replacementStore.loadLanes();
    assert.equal(restoredLanes.length, 2, 'production lane store lost a released lane across restart');
    assert.ok(restoredLanes.every(lane => lane.phase === 'held' && lane.reason === 'restart'),
      'active/released lanes were not restart-held by the production lane store');
    let confirmedOrds = null;
    replacement = await fixture(ctx, 'drain-restart-recovered', true, {
      userData, source, store: replacementStore, restoredLanes,
      oauthStore: createOAuthStore({ filePath: oauthStatePath }),
      random: randomBytes(7), holdMs: 15, submitBudgetMs: 25000,
      confirmRestart: async ords => { confirmedOrds = ords.slice(); return true; },
    });
    assert.deepEqual(replacement.engine.snapshot().queue.jobs.map(job => job.phase), ['held', 'held'], 'replacement engine did not expose restart holds before confirmation');
    assert.equal(replacement.engine.restartJobs().length, 2, 'replacement engine lost restart confirmation targets');
    const grant = replacement.oauth.authenticate({ headers: { authorization: 'Bearer ' + firstToken.access_token } });
    assert.equal(typeof grant?.linkId, 'string', 'persisted OAuth link did not survive the graph replacement');
    await withSdkClient(replacement, loaded, firstToken, async client => {
      // Before any replacement chat is minted, the real MCP listener must
      // report the pre-restart session as ended rather than authenticate it.
      const oldChat = await callSdkTool(client, 'get_handoff', { session: originalChat.sessionCode }, 'restart old chat must end');
      assert.equal(oldChat.status, 'session_ended', 'old chat survived a full listener/OAuth/engine replacement');
    });
    const resumedChat = await replacement.engine.newChat({ linkId: grant.linkId });
    assert.equal(resumedChat.copied, true, 'replacement engine did not mint after restart confirmation');
    assert.notEqual(resumedChat.sessionCode, originalChat.sessionCode, 'replacement reused the pre-restart chat session material');
    assert.deepEqual(confirmedOrds, [1, 2], 'restart confirmation did not cover both durable lanes');
    const token = await refresh(replacement.socket, firstToken);
    await withSdkClient(replacement, loaded, token, async client => {
      const recovered = await callSdkTool(client, 'get_handoff', { session: resumedChat.sessionCode }, 'restart recovered get_handoff');
      assert.equal(recovered.status, 'served', 'replacement engine did not re-read the active lane through the Unix listener');
      assert.notEqual(recovered.handoffCode, active.handoffCode, 'replacement reused a pre-restart in-memory handoff code');
      const stalePreRestart = await callSdkTool(client, 'submit_handoff', {
        session: resumedChat.sessionCode, handoffCode: active.handoffCode,
        response: answer(JOB_ADA, active.handoffCode, '', active.stage),
      }, 'restart stale handoff');
      assert.equal(stalePreRestart.status, 'unknown_handoff', 'pre-restart handoff code must fail closed without reaching the source');
      assert.equal(source.submitted.length, 0, 'stale pre-restart code reached the application source');
      const accepted = await callSdkTool(client, 'submit_handoff', {
        session: resumedChat.sessionCode, handoffCode: recovered.handoffCode,
        response: answer(JOB_ADA, recovered.handoffCode, '', recovered.stage),
      }, 'restart recovered submit');
      assert.equal(accepted.status, 'accepted', 'recovered active lane could not be completed');
      const second = await callSdkTool(client, 'get_handoff', { session: resumedChat.sessionCode }, 'restart recovered second get');
      assert.equal(second.status, 'served', 'second durable lane was not retained after active-lane recovery');
      assert.equal(second.handoffCode, 'MARISOL-HANDOFF-002', 'second recovered lane drifted');
    });
  } finally {
    try { await replacement?.close(); } catch { /* cleanup only */ }
    try { await first?.close(); } catch { /* cleanup only */ }
  }
}

async function drain(ctx, loaded) {
  await assertAbortMidHold();
  await assertRestartMidDrain(ctx, loaded);

  const env = await fixture(ctx, 'drain-wire', true);
  try {
    const token = await link(env, env.socket);
    const grant = env.oauth.authenticate({ headers: { authorization: 'Bearer ' + token.access_token } });
    assert.equal((await env.engine.release({ jobs: [
      { jobId: JOB_ADA, canvasFilePath: '/tmp/ic-b-wire-ada.canvas' },
      { jobId: JOB_MARISOL, canvasFilePath: '/tmp/ic-b-wire-marisol.canvas' },
    ] })).ok, true, 'SDK drain fixture must release two jobs');
    const chat = await env.engine.newChat({ linkId: grant.linkId });
    await withSdkClient(env, loaded, token, async client => {
      const first = await callSdkTool(client, 'get_handoff', { session: chat.sessionCode }, 'SDK first get_handoff');
      assert.equal(first.status, 'served', 'SDK client did not receive the first released job over the real socket');
      assert.equal(first.handoffCode, 'ADA-HANDOFF-001', 'SDK first job order drifted');
      const sixty = answerWithExactBytes(JOB_ADA, first.handoffCode, 60 * 1024, first.stage);
      const accepted = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode, handoffCode: first.handoffCode, response: sixty,
      }, 'SDK 60 KB submit_handoff');
      assert.equal(accepted.status, 'accepted', '60 KB SDK result must save');
      assert.equal(Buffer.byteLength(sixty, 'utf8'), 60 * 1024, '60 KB SDK response was not exact');
      assert.equal(env.source.submitted[0]?.response, sixty, '60 KB SDK response bytes changed before source submit');

      const duplicate = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode, handoffCode: first.handoffCode, response: sixty,
      }, 'SDK duplicate submit_handoff');
      assert.equal(duplicate.status, 'duplicate', 'SDK duplicate must be cached and never resubmitted');
      assert.equal(env.source.submitted.length, 1, 'SDK duplicate reached the application source');
      const wrong = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode, handoffCode: 'WRONG-CODE', response: answer(JOB_ADA, 'WRONG-CODE', '', first.stage),
      }, 'SDK wrong-code submit_handoff');
      assert.equal(wrong.status, 'unknown_handoff', 'wrong SDK handoff code must fail closed');
      assert.equal(env.source.submitted.length, 1, 'wrong SDK handoff code reached the application source');

      const second = await callSdkTool(client, 'get_handoff', { session: chat.sessionCode }, 'SDK second get_handoff');
      assert.equal(second.status, 'served', 'SDK client did not receive the second released job');
      assert.equal(second.handoffCode, 'MARISOL-HANDOFF-002', 'SDK second job order drifted');
      env.source.rejectNext();
      const twentyFive = answerWithExactBytes(JOB_MARISOL, second.handoffCode, 25 * 1024, second.stage);
      const rejected = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode, handoffCode: second.handoffCode, response: twentyFive,
      }, 'SDK rejection submit_handoff');
      assert.equal(rejected.status, 'rejected', 'SDK synthetic rejection did not frame a correction');
      assert.notEqual(rejected.handoffCode, second.handoffCode, 'rejection must rotate the current handoff code');
      assert.equal(Buffer.byteLength(twentyFive, 'utf8'), 25 * 1024, '25 KB SDK argument was not exact');
      assert.equal(env.source.submitted[1]?.response, twentyFive, '25 KB SDK argument bytes changed before source submit');
      assert.deepEqual(env.source.submitted.slice(0, 2).map(item => item.jobId), [JOB_ADA, JOB_MARISOL], 'SDK workflow did not submit both released jobs');

      const staleCode = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode, handoffCode: second.handoffCode, response: answer(JOB_MARISOL, second.handoffCode, '', second.stage),
      }, 'SDK stale-code submit_handoff');
      assert.equal(staleCode.status, 'superseded', 'rotated stale code must be reported as superseded');
      const correction = await callSdkTool(client, 'get_handoff', { session: chat.sessionCode }, 'SDK correction get_handoff');
      assert.equal(correction.status, 'served', 'SDK correction was not re-served');
      assert.equal(correction.handoffCode, rejected.handoffCode, 'SDK correction code drifted');
      const junk = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode, handoffCode: correction.handoffCode, response: '{}',
      }, 'SDK junk submit_handoff');
      assert.equal(junk.status, 'junk', 'SDK junk answer must not save');
      const staleStage = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode,
        handoffCode: correction.handoffCode,
        response: answer(JOB_MARISOL, correction.handoffCode, '', 'evidence-plan'),
      }, 'SDK stale-stage submit_handoff');
      assert.equal(staleStage.status, 'superseded', 'SDK stale stage must fail closed');

      const five = await Promise.all(Array.from({ length: 5 }, (_unused, index) => withSdkClient(env, loaded, token, peer =>
        callSdkTool(peer, 'get_handoff', { session: chat.sessionCode }, 'SDK concurrent get_handoff ' + index))));
      assert.ok(five.every(value => value.status === 'served' && value.handoffCode === correction.handoffCode),
        'five real SDK clients did not all receive the active correction over the Unix socket');
      const corrected = await callSdkTool(client, 'submit_handoff', {
        session: chat.sessionCode,
        handoffCode: correction.handoffCode,
        response: answer(JOB_MARISOL, correction.handoffCode, '', correction.stage),
      }, 'SDK corrected submit_handoff');
      assert.equal(corrected.status, 'accepted', 'SDK corrected answer did not complete the second job');
      assert.equal(env.source.submitted.length, 3, 'only accepted/rejected/corrected source submissions should reach the application');
    });
  } finally { await env.close(); }
}

async function push() {
  const calls = [];
  const score = {
    async get() { return { status: 'served', handoffCode: 'PUSH-ADA-001', task: 'job-scoring', batch: 1, batchTotal: 1, attempt: 1, prompt: 'Score synthetic Ada Lovelace role at Example Systems.', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
    async submit(value) { calls.push(value); return { status: 'accepted' }; },
    async nextAfterAccept() { return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } }; },
    status() { return { served: 0, held: 0, selectedHubs: [], discovered: [] }; },
    closeEpoch() {},
  };
  const application = { read: async () => ({ kind: 'waiting' }), status: async () => ({ kind: 'host' }), submit: async () => ({ kind: 'accepted' }) };
  const engine = createHandoffEngine({ sources: { application, push: score }, scope: { applications: true, scoring: true }, random: randomBytes(), holdMs: 0 });
  try {
    const chat = await engine.newChat({ linkId: 'push-link' });
    const served = await engine.get({ session: chat.sessionCode, linkId: 'push-link' });
    assert.equal(served.kind, 'push', 'push must win at a job boundary');
    const response = JSON.stringify({ handoffCode: served.handoffCode, score: 8, persona: 'Ada Lovelace' });
    assert.equal((await engine.submit({ session: chat.sessionCode, linkId: 'push-link', handoffCode: served.handoffCode, response })).status, 'accepted', 'push submit must accept');
    assert.equal(calls[0]?.response, response, 'push response changed');
    const duplicate = await engine.submit({ session: chat.sessionCode, linkId: 'push-link', handoffCode: served.handoffCode, response });
    assert.ok(['accepted', 'duplicate'].includes(duplicate.status), 'push replay unsafe');
    assert.equal(calls.length, 1, 'push replay wrote twice');
  } finally { await engine.close(); }
}

function lcg(seed = 0x51f15e) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    return state >>> 0;
  };
}

function handles() {
  return process.getActiveResourcesInfo().filter(name => !['PipeWrap', 'TTYWrap'].includes(name)).length;
}

function slowClient(sock, source = '198.51.100.10') {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: sock });
    client.once('connect', () => {
      // Keep 200 anonymous TCP/header readers occupied without completing a
      // request.  This is deliberate: completing three distinct slow OAuth
      // bodies would make any fourth pre-auth token body shed by design, not
      // demonstrate the reserved authenticated MCP pools.
      client.write('POST /oauth/token HTTP/1.1\r\nHost: ' + HOST + '\r\nCf-Connecting-Ip: ' + source + '\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 8192\r\nX-Slow: ');
      resolve(client);
    });
    client.once('error', reject);
    client.on('error', () => undefined);
  });
}

function continuousDrainSource() {
  let round = 1;
  const submitted = [];
  const handoff = jobId => ({
    code: 'ABUSE-HANDOFF-' + String(round).padStart(4, '0'),
    jobId,
    stage: 'resume',
    revision: round,
    prompt: 'Synthetic continued authenticated drain for Ada Lovelace at Example Systems.',
  });
  return {
    submitted,
    api: {
      async read({ jobId }) { return { kind: 'open', handoff: handoff(jobId) }; },
      async status() { return { kind: 'host' }; },
      async submit({ jobId }, value = {}) {
        submitted.push({ jobId, handoffCode: value.code, response: value.text });
        round += 1;
        return { kind: 'accepted', completed: false, handoff: handoff(jobId) };
      },
    },
  };
}

async function socketTool(env, token, id, name, arguments_, label) {
  const response = await env.socket({
    method: 'POST',
    path: '/mcp',
    headers: { authorization: 'Bearer ' + token.access_token, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }),
  });
  assert.equal(response.status, 200, label + ' did not reach the authenticated MCP route');
  const body = json(json(response.body)?.result?.content?.[0]?.text);
  assert.ok(body && typeof body === 'object', label + ' did not return a parseable MCP tool result');
  return body;
}

const FUZZ_CASES = Object.freeze([
  'protected_resource_get', 'protected_resource_head', 'token_bad_form', 'token_bad_json', 'token_bad_mime',
  'revoke_bad_form', 'authorize_closed_get', 'authorize_closed_post', 'mcp_forged_malformed', 'mcp_missing_bearer',
  'mcp_wrong_mime', 'mcp_delete', 'unknown_route', 'ambiguous_path', 'host_mismatch', 'prototype_json',
  'oauth_oversize', 'mcp_unknown_tool', 'token_get', 'well_known_post', 'backslash_path',
]);

// Each generated family has a deliberately small protocol contract.  In
// particular, a new 2xx on a hostile request is not masked by the old broad
// "no 5xx" oracle.  429 remains acceptable where the anonymous limiter can
// legitimately shed a flood; only the oversized body may close early.
const FUZZ_ALLOWED_STATUS = Object.freeze([
  new Set([200, 429]), new Set([200, 429]), new Set([400, 401, 429]), new Set([400, 401, 415, 429]), new Set([400, 415, 429]),
  new Set([200, 400, 401, 429]), new Set([403, 429]), new Set([400, 403, 405, 429]), new Set([401, 429]), new Set([401, 429]),
  new Set([401, 415, 429]), new Set([400, 401, 405, 429]), new Set([404, 429]), new Set([400, 404, 429]), new Set([421]),
  new Set([401, 429]), new Set([0, 413, 429]), new Set([401, 429]), new Set([405, 429]), new Set([405, 429]),
  new Set([400, 404, 429]),
]);
assert.equal(FUZZ_ALLOWED_STATUS.length, FUZZ_CASES.length, 'fuzz oracle must cover every request family');

function fuzzInput(choice, index, random) {
  const marker = String(random() >>> 0);
  switch (choice) {
    case 0: return { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' };
    case 1: return { method: 'HEAD', path: '/.well-known/oauth-protected-resource/mcp' };
    case 2: return { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=bad-' + marker };
    case 3: return { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/json' }, body: '{"grant_type":"refresh_token","refresh_token":' + JSON.stringify(marker) + '}' };
    case 4: return { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'text/plain' }, body: 'grant_type=refresh_token' };
    case 5: return { method: 'POST', path: '/oauth/revoke', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=bad-' + marker + '&client_id=' + encodeURIComponent(CLIENT_ID) };
    case 6: return { method: 'GET', path: '/oauth/authorize?response_type=code&client_id=' + encodeURIComponent(CLIENT_ID) + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) + '&resource=' + encodeURIComponent(RESOURCE) };
    case 7: return { method: 'POST', path: '/oauth/authorize', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'txn=bad-' + marker + '&action=approve&pairing_code=22222-22222' };
    case 8: return { method: 'POST', path: '/mcp', headers: { authorization: 'Bearer forged-' + marker, 'content-type': 'application/json' }, body: '[' };
    case 9: return { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{}' };
    case 10: return { method: 'POST', path: '/mcp', headers: { authorization: 'Bearer forged-' + marker, 'content-type': 'text/plain' }, body: '{}' };
    case 11: return { method: 'DELETE', path: '/mcp', headers: { authorization: 'Bearer forged-' + marker, 'content-type': 'application/json' }, body: '{}' };
    case 12: return { method: 'GET', path: '/not-a-route-' + index };
    case 13: return { method: 'GET', path: '//ambiguous-' + marker };
    case 14: return { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp', headers: { host: 'localhost:43192' } };
    case 15: return { method: 'POST', path: '/mcp', headers: { authorization: 'Bearer forged-' + marker, 'content-type': 'application/json' }, body: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}' };
    case 16: return { method: 'POST', path: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x='.padEnd(9001, 'x') };
    case 17: return { method: 'POST', path: '/mcp', headers: { authorization: 'Bearer forged-' + marker, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: index, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } }) };
    case 18: return { method: 'GET', path: '/oauth/token' };
    case 19: return { method: 'POST', path: '/.well-known/oauth-protected-resource/mcp', headers: { 'content-type': 'application/json' }, body: '{}' };
    case 20: return { method: 'GET', path: '/\\bad-' + marker };
    default: throw new Error('unknown deterministic fuzz case ' + choice);
  }
}

async function abuse(ctx) {
  const source = continuousDrainSource();
  const env = await fixture(ctx, 'abuse', true, { source, holdMs: 25, submitBudgetMs: 25000 });
  const random = lcg();
  const slow = [];
  const fuzzKinds = new Set();
  const fuzzStatuses = new Set();
  const oracleErrors = new Map();
  const serverErrors = new Map();
  let fuzzResponses = 0;
  let fuzzZeroResponses = 0;
  let fuzzEarlyCloses = 0;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  let heap = 0;
  const active = handles();
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    let token = await link(env, env.socket);
    const grant = env.oauth.authenticate({ headers: { authorization: 'Bearer ' + token.access_token } });
    assert.equal((await env.engine.release({ jobs: [{ jobId: JOB_ADA, canvasFilePath: '/tmp/ic-b-abuse.canvas' }] })).ok, true, 'abuse fixture release failed');
    const chat = await env.engine.newChat({ linkId: grant.linkId });
    let current = await socketTool(env, token, 'abuse-initial-get', 'get_handoff', { session: chat.sessionCode }, 'initial authenticated drain get_handoff');
    assert.equal(current.status, 'served', 'abuse fixture did not start an engine-backed authenticated drain');
    loop.enable();
    heap = process.memoryUsage().heapUsed;
    // Generate and dispatch one case at a time: this keeps the harness from
    // retaining 10,000 request bodies while still sending the full seeded
    // corpus through Node's real parser and the production Unix listener.
    for (let index = 0; index < 10000; index += 1) {
      const choice = random() % FUZZ_CASES.length;
      fuzzKinds.add(FUZZ_CASES[choice]);
      let status;
      try { status = (await env.socket(fuzzInput(choice, index, random))).status; }
      catch (error) {
        // The anonymous body limiter is allowed to close an over-limit body
        // while the client is still writing it. EPIPE/ECONNRESET is the
        // transport form of that fail-closed decision, not a server crash.
        if (choice === 16 && ['EPIPE', 'ECONNRESET'].includes(error?.code)) { fuzzEarlyCloses += 1; status = 0; }
        else throw error;
      }
      fuzzResponses += 1;
      fuzzStatuses.add(status);
      if (status === 0) fuzzZeroResponses += 1;
      if (!FUZZ_ALLOWED_STATUS[choice].has(status)) {
        const key = FUZZ_CASES[choice] + ':' + status;
        oracleErrors.set(key, (oracleErrors.get(key) || 0) + 1);
      }
      if (status >= 500) {
        const key = FUZZ_CASES[choice] + ':' + status;
        serverErrors.set(key, (serverErrors.get(key) || 0) + 1);
      }
    }
    assert.deepEqual([...fuzzKinds].sort(), [...FUZZ_CASES].sort(), 'seeded 10k fuzz corpus did not exercise every declared request family');
    assert.equal(fuzzResponses, 10000, 'every seeded fuzz request must traverse the real Unix listener');
    assert.ok(fuzzStatuses.size >= 5, 'seeded fuzz corpus did not produce diverse response classes');
    assert.equal(oracleErrors.size, 0,
      'fuzz status oracle rejected responses: ' + JSON.stringify(Object.fromEntries(oracleErrors)));

    for (let index = 0; index < 200; index += 1) slow.push(await slowClient(env.sock));

    const garbage = [];
    const burstStarts = [];
    let activeGarbage = 0;
    const floodStartedAt = Date.now();
    for (let burst = 0; burst < 10; burst += 1) {
      const scheduledAt = floodStartedAt + burst * 100;
      await delay(Math.max(0, scheduledAt - Date.now()));
      const dispatchedAt = Date.now();
      burstStarts.push(dispatchedAt);
      assert.ok(dispatchedAt - scheduledAt <= 100, '100 rps garbage dispatch fell behind its fixed window at burst ' + burst);
      for (let item = 0; item < 10; item += 1) {
        activeGarbage += 1;
        garbage.push(env.socket({ method: 'POST', path: '/mcp', headers: { authorization: 'Bearer garbage-' + burst + '-' + item, 'content-type': 'application/json' }, body: '{' })
          .then(value => {
            if (value.status >= 500) serverErrors.set('garbage:' + value.status, (serverErrors.get('garbage:' + value.status) || 0) + 1);
          }, error => {
            serverErrors.set('garbage-transport:' + (error?.code || 'error'), (serverErrors.get('garbage-transport:' + (error?.code || 'error')) || 0) + 1);
          })
          .finally(() => { activeGarbage -= 1; }));
      }
      assert.ok(activeGarbage > 0, 'garbage requests did not overlap the authenticated drain at burst ' + burst);
      const authenticated = await socketTool(env, token, 'abuse-submit-' + burst, 'submit_handoff', {
        session: chat.sessionCode,
        handoffCode: current.handoffCode,
        response: answer(JOB_ADA, current.handoffCode, '', current.stage),
      }, 'authenticated continued drain submit ' + burst);
      assert.equal(authenticated.status, 'accepted', 'engine-backed authenticated submit lost during 100 rps garbage at burst ' + burst);
      assert.equal(authenticated.next?.status, 'served', 'continued engine-backed drain did not produce a successor at burst ' + burst);
      current = authenticated.next;
      token = await refresh(env.socket, token);
    }
    const dispatchSpan = burstStarts.at(-1) - burstStarts[0];
    assert.ok(dispatchSpan >= 850 && dispatchSpan <= 1300, 'garbage dispatch was not a sustained ten-window 100 rps run: ' + dispatchSpan + 'ms');
    assert.ok(burstStarts.every((stamp, index) => index === 0 || stamp - burstStarts[index - 1] >= 70 && stamp - burstStarts[index - 1] <= 180),
      'garbage flood windows were not paced at 100 rps');
    await Promise.all(garbage);
    assert.equal(garbage.length, 100, 'garbage flood did not dispatch exactly 100 requests');
    assert.equal(source.submitted.length, 10, 'authenticated drain did not continue through every garbage flood window');
  } finally {
    loop.disable();
    for (const client of slow) try { client.destroy(); } catch { /* already closed */ }
    await delay(50);
    await env.close();
  }
  const p99 = loop.percentile(99) / 1000000;
  const max = loop.max / 1000000;
  assert.equal(serverErrors.size, 0, 'an abuse response was a 5xx or unexpected transport error: ' + JSON.stringify(Object.fromEntries(serverErrors)));
  assert.equal(fuzzZeroResponses, fuzzEarlyCloses,
    'only an over-limit fuzz body may end in an expected early transport close');
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore, 'Object.prototype changed during fuzz');
  assert.ok(p99 < 50, 'event-loop p99 ' + p99.toFixed(2) + 'ms exceeds 50ms; reopen utilityProcess isolation');
  assert.ok(max < 250, 'event-loop max ' + max.toFixed(2) + 'ms exceeds 250ms; reopen utilityProcess isolation');
  const heapGrowth = process.memoryUsage().heapUsed - heap;
  assert.ok(heapGrowth < 64 * 1024 * 1024, 'heap exceeded bounded abuse budget: ' + heapGrowth + ' bytes');
  assert.ok(handles() - active < 30, 'socket handles remained after slow-client cleanup');
}

function memoryAuditFs() {
  const files = new Map();
  const handles = new Map();
  let nextHandle = 1;
  const missing = () => Object.assign(new Error('missing audit path'), { code: 'ENOENT' });
  return Object.freeze({
    mkdirSync() {},
    chmodSync() {},
    openSync(target) {
      if (!files.has(target)) files.set(target, { chunks: [], size: 0 });
      const handle = nextHandle++;
      handles.set(handle, target);
      return handle;
    },
    writeSync(handle, bytes, offset, length) {
      const target = handles.get(handle);
      if (!target) throw missing();
      const chunk = Buffer.from(bytes).subarray(offset, offset + length);
      const file = files.get(target);
      file.chunks.push(chunk);
      file.size += chunk.length;
      return chunk.length;
    },
    fsyncSync() {},
    closeSync(handle) { handles.delete(handle); },
    statSync(target) {
      if (!files.has(target)) throw missing();
      return { size: files.get(target).size };
    },
    existsSync: target => files.has(target),
    unlinkSync(target) {
      if (!files.delete(target)) throw missing();
    },
    renameSync(from, to) {
      if (!files.has(from)) throw missing();
      files.set(to, files.get(from));
      files.delete(from);
    },
  });
}

const SOAK_PRIMARY_MCP_REQUESTS = 2; // get_handoff + submit_handoff
const SOAK_REFRESH_EVERY = 20;
// A fresh Streamable HTTP client performs initialize, notifications/initialized,
// and the explicit tools/list below. Keep this accounting tied to the concrete
// protocol sequence rather than hiding a limiter failure behind a sleep.
const SOAK_REFRESH_PEER_MCP_REQUESTS = 3;
const SOAK_REFILL_HEADROOM = 0.75;

function soakCycleDelayMs() {
  const capacity = Number(CONSTANTS?.AUTHENTICATED_GRANT_BUCKET_CAPACITY);
  const refillPerSecond = Number(CONSTANTS?.AUTHENTICATED_GRANT_BUCKET_REFILL_PER_SECOND);
  assert.ok(Number.isFinite(capacity) && capacity >= SOAK_PRIMARY_MCP_REQUESTS,
    'soak requires an authenticated grant bucket large enough for one tool cycle');
  assert.ok(Number.isFinite(refillPerSecond) && refillPerSecond > 0,
    'soak requires a positive authenticated grant bucket refill rate');
  const averageRequests = SOAK_PRIMARY_MCP_REQUESTS + SOAK_REFRESH_PEER_MCP_REQUESTS / SOAK_REFRESH_EVERY;
  const sustainedBudget = refillPerSecond * SOAK_REFILL_HEADROOM;
  const delayMs = Math.ceil(1000 * averageRequests / sustainedBudget);
  assert.ok(delayMs > 0 && Number.isSafeInteger(delayMs), 'soak cadence must be a positive safe interval');
  assert.ok(averageRequests / (delayMs / 1000) <= sustainedBudget,
    'soak authenticated request cadence exceeds its explicit sustained grant budget');
  return delayMs;
}

async function soak(ctx, options, loaded) {
  const userData = ctx.make('soak');
  // Keep ledger rotation deterministic and in memory, while the actual soak
  // remains a live listener/OAuth/SDK/engine session for its whole duration.
  // Production append/fsync behaviour is covered by the injected audit tests;
  // this avoids making a ten-minute protocol soak a disk benchmark.
  const auditFs = memoryAuditFs();
  const audit = createAuditSink({ userDataPath: userData, fsImpl: auditFs });
  const source = continuousDrainSource();
  const env = await fixture(ctx, 'soak-live', true, {
    userData, source, audit, holdMs: 10, submitBudgetMs: 25000,
  });
  const until = Date.now() + (options.soakMs ?? 600000);
  const cycleDelayMs = soakCycleDelayMs();
  const baselineHeap = process.memoryUsage().heapUsed;
  const baselineHandles = handles();
  try {
    let token = await link(env, env.socket);
    const grant = env.oauth.authenticate({ headers: { authorization: 'Bearer ' + token.access_token } });
    assert.equal((await env.engine.release({ jobs: [{ jobId: JOB_ADA, canvasFilePath: '/tmp/ic-b-soak.canvas' }] })).ok, true,
      'soak fixture release failed');
    const chat = await env.engine.newChat({ linkId: grant.linkId });
    let session = chat.sessionCode;
    await audit.security('link_created', { clientAuth: 'none' });
    for (let index = 0; index < 25000; index += 1) {
      await audit.serve('served', { tool: 'get_handoff', outcome: 'ok', stage: 'resume', argBytes: index % 100, resultBytes: index % 100 });
    }
    await audit.flush();
    assert.ok(auditFs.existsSync(audit.servePath + '.1'), 'serve ledger did not rotate under synthetic call volume');
    assert.ok(!auditFs.existsSync(audit.securityPath + '.1'), 'security ledger rotated because of serve call volume');
    let iterations = 0;
    let nextCycleAt = Date.now();
    await withSdkClient(env, loaded, token, async client => {
      while (Date.now() < until) {
        const waitMs = nextCycleAt - Date.now();
        if (waitMs > 0) await delay(Math.min(waitMs, Math.max(0, until - Date.now())));
        if (Date.now() >= until) break;
        let served = await callSdkTool(client, 'get_handoff', { session }, 'soak get_handoff');
        if (served.status === 'session_full') {
          const continued = await env.engine.continueChat({ linkId: grant.linkId });
          assert.equal(continued.copied, true, 'live soak could not rotate a full chat');
          session = continued.sessionCode;
          served = await callSdkTool(client, 'get_handoff', { session }, 'soak continued get_handoff');
        }
        assert.equal(served.status, 'served', 'live soak engine stopped serving');
        const submitted = await callSdkTool(client, 'submit_handoff', {
          session, handoffCode: served.handoffCode,
          response: answer(JOB_ADA, served.handoffCode, '', served.stage),
        }, 'soak submit_handoff');
        assert.equal(submitted.status, 'accepted', 'live soak engine stopped accepting');
        iterations += 1;
        // Exercise refresh rotation during the same live fixture, then prove
        // the new access token works through a second SDK transport.
        if (iterations === 1 || iterations % 20 === 0) {
          token = await refresh(env.socket, token);
          await withSdkClient(env, loaded, token, peer => peer.listTools());
        }
        // Advance from the scheduled start rather than adding arbitrary rest
        // after work. A slow real request only lowers the request rate.
        nextCycleAt = Math.max(nextCycleAt + cycleDelayMs, Date.now());
      }
    });
    assert.ok(iterations > 0, 'soak duration ended before one real SDK engine cycle');
    await audit.flush();
    assert.ok(auditFs.statSync(audit.securityPath).size < 5 * 1024 * 1024, 'security ledger grew with call volume');
    assert.ok(process.memoryUsage().heapUsed - baselineHeap < 64 * 1024 * 1024, 'live soak heap exceeded its bounded budget');
    assert.ok(handles() - baselineHandles < 10, 'live soak accumulated active resources');
  } finally { await env.close(); }
}

function fakeBinary(userData) {
  const tunnel = path.join(userData, 'handoff-bridge', 'tunnel');
  const bin = path.join(tunnel, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const program = path.join(tunnel, 'fake-cloudflared.mjs');
  const binary = path.join(bin, 'cloudflared-deadbeef');
  fs.writeFileSync(program, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n", { mode: 0o600 });
  fs.writeFileSync(binary, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(program) + ' "$0" "$@"\n', { mode: 0o755 });
  fs.chmodSync(binary, 0o755);
  return { tunnel, binary, config: path.join(tunnel, 'config.yml') };
}

function fakeCredentials(fake, tunnelId) {
  const credentialsPath = path.join(fake.tunnel, tunnelId + '.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    TunnelID: tunnelId,
    TunnelSecret: 'synthetic-' + 'x'.repeat(64),
  }) + '\n', { mode: 0o600 });
  fs.chmodSync(credentialsPath, 0o600);
  return credentialsPath;
}

function processRows() {
  try {
    return parsePsRows(String(execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000, maxBuffer: 1024 * 1024,
    })));
  } catch { return null; }
}

function row(pid) {
  return processRows()?.find(item => item.pid === pid) || null;
}

function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}

function groupRows(pgid) {
  const rows = processRows();
  return rows === null ? null : rows.filter(item => item.pgid === pgid);
}

async function waitFor(predicate, timeout, label) {
  const ends = Date.now() + timeout;
  while (Date.now() < ends) {
    if (await predicate()) return;
    await delay(20);
  }
  die(label + ' timed out');
}

function orphanChild(binary, argv) {
  const resolvedBinary = fs.realpathSync(binary);
  assert.ok(under(fs.realpathSync(os.tmpdir()), resolvedBinary), 'orphan helper binary must be generated below os.tmpdir()');
  assert.ok(Array.isArray(argv) && argv.every(value => typeof value === 'string'), 'orphan helper argv must be a fixed string array');
  return new Promise((resolve, reject) => {
    const source = 'import { spawn } from "node:child_process";const c=spawn(' + JSON.stringify(resolvedBinary) + ',' + JSON.stringify(argv) + ',{detached:true,stdio:"ignore"});c.unref();process.stdout.write(String(c.pid));';
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('close', code => code === 0 && /^\d+$/.test(output.trim()) ? resolve(Number(output.trim())) : reject(new Error('orphan helper did not yield a pid')));
  });
}

function startSupervisorHelper({ userData, socketPath: sock, credentialsPath, binaryPath, pin }) {
  const supervisorUrl = new URL('../../electron/ipc/handoffBridge/tunnel/supervisor.js', import.meta.url).href;
  const settings = { userData, hostname: HOST, socketPath: sock, credentialsPath, binaryPath, pin, HOME: path.join(userData, 'empty-home'), TMPDIR: userData };
  const program = [
    "import fs from 'node:fs';",
    "import dgram from 'node:dgram'; import dns from 'node:dns'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';",
    "const deny = api => { throw Object.assign(new Error('conformance child egress denied: ' + api), { code: 'ERR_IC_CONFORMANCE_EGRESS' }); };",
    "net.createConnection = (..._args) => deny('net.createConnection'); net.connect = (..._args) => deny('net.connect'); net.Socket.prototype.connect = (..._args) => deny('net.Socket.connect');",
    "http.request = (..._args) => deny('http.request'); http.get = (..._args) => deny('http.get'); https.request = (..._args) => deny('https.request'); https.get = (..._args) => deny('https.get'); tls.connect = (..._args) => deny('tls.connect'); dgram.createSocket = (..._args) => deny('dgram.createSocket');",
    "const dnsNames = ['lookup', 'lookupService', 'getDefaultResultOrder', 'setDefaultResultOrder', 'getServers', 'setServers', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse']; const resolverNames = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse']; const blockDns = (api, prefix, names) => { for (const name of names) if (typeof api[name] === 'function') api[name] = (..._args) => deny(prefix + '.' + name); }; blockDns(dns, 'dns', dnsNames); blockDns(dns.promises, 'dns.promises', dnsNames); blockDns(dns.Resolver?.prototype || {}, 'dns.Resolver', resolverNames); blockDns(dns.promises.Resolver?.prototype || {}, 'dns.promises.Resolver', resolverNames); globalThis.fetch = (..._args) => deny('fetch');",
    `const settings = ${JSON.stringify(settings)};`,
    `const { createTunnelSupervisor } = await import(${JSON.stringify(supervisorUrl)});`,
    "const dryRun = async (_binary, argv) => { const configPath = argv[argv.indexOf('--config') + 1]; const target = argv.at(-1); if (target === 'validate') return { ok: true, output: 'Validating rules from ' + configPath + '\\nOK' }; if (target === 'https://' + settings.hostname + '/mcp') return { ok: true, output: 'rule #0 https://' + settings.hostname + '/mcp unix:' + settings.socketPath }; return { ok: true, output: 'rule #1 http_status:404' }; };",
    // Binary-copy integrity has already been covered by the B3 tests. This
    // helper deliberately reaches the real supervisor/watchdog with a fixed,
    // synthetic app-owned copy so only the crash-cleanup seam is under test.
    "const approvedCopy = Object.freeze({ ok: true, copyPath: settings.binaryPath, sha256: settings.pin, approved: true });",
    "const supervisor = createTunnelSupervisor({ ...settings, testMode: true, dryRun, prepareBinary: async () => approvedCopy, verifyPinnedCopy: () => ({ ok: true }), chooseMetricsPort: () => 49152, probeReady: async () => ({ ok: true, state: 'ready' }), publicProbeFn: async () => ({ ok: true, code: 'ok' }), reapOrphans: async () => ({ ok: true, reaped: 0, notices: [] }) });",
    "const started = await supervisor.start();",
    "if (!started.ok) { console.error('supervisor start failed: ' + JSON.stringify(started)); process.exitCode = 1; } else { const intent = JSON.parse(fs.readFileSync(settings.userData + '/handoff-bridge/tunnel/tunnel.pid.json', 'utf8')); process.stdout.write('READY:' + JSON.stringify({ wrapperPid: intent.pid }) + '\\n'); setInterval(() => undefined, 1000); }",
  ].join('\n');
  return new Promise((resolve, reject) => {
    const helper = spawn(process.execPath, ['--input-type=module', '--eval', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let diagnostics = ''; let settled = false; let timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (value instanceof Error) reject(value); else resolve(value);
    };
    timer = setTimeout(() => {
      try { helper.kill('SIGKILL'); } catch { /* helper already exited */ }
      finish(new Error('supervisor helper did not become ready: ' + diagnostics.trim()));
    }, 5000);
    timer.unref?.();
    const consume = chunk => {
      output += String(chunk);
      const lines = output.split('\n');
      output = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('READY:')) continue;
        try {
          const payload = JSON.parse(line.slice('READY:'.length));
          if (!Number.isInteger(payload?.wrapperPid) || payload.wrapperPid <= 1) throw new Error('bad helper wrapper pid');
          finish({ helper, wrapperPid: payload.wrapperPid });
        } catch (error) { finish(error); }
      }
    };
    helper.stdout.on('data', consume);
    helper.stderr.on('data', chunk => { diagnostics += String(chunk).slice(0, 4096 - diagnostics.length); });
    helper.once('error', error => finish(error));
    helper.once('exit', (code, signal) => {
      if (!settled) finish(new Error('supervisor helper exited before ready (' + code + '/' + signal + '): ' + diagnostics.trim()));
    });
  });
}

async function tunnel(ctx) {
  if (process.platform !== 'darwin') {
    console.log('handoff bridge conformance: tunnel: skipped (Darwin-only process-group/watchdog semantics)');
    return;
  }
  const userData = ctx.make('tunnel');
  const fake = fakeBinary(userData);
  const sock = socketPath(userData);
  const supervisorUserData = fs.realpathSync(userData);
  const supervisorSock = socketPath(supervisorUserData);
  const supervisorConfig = path.join(supervisorUserData, 'handoff-bridge', 'tunnel', 'config.yml');
  const supervisorBinary = fs.realpathSync(fake.binary);
  const tunnelId = '123e4567-e89b-42d3-a456-426614174000';
  const credentialsPath = fakeCredentials(fake, tunnelId);
  const config = renderTunnelConfig({ tunnelId, hostname: HOST, credentialsPath, socketPath: sock });
  assert.ok(config?.includes('service: "unix:' + sock + '"'), 'tunnel config did not select Unix origin');
  const argv = buildRunArgv({ configPath: fake.config, tunnelId, metricsPort: 49152 });
  assert.ok(argv?.includes('--grace-period') && argv.includes('2s') && argv.includes('--management-diagnostics=false'), 'mandatory tunnel stop flags missing');
  assert.ok(!argv.some(value => /--token|--unix-socket|--pidfile|debug|trace/.test(value)), 'forbidden tunnel argv');
  fs.writeFileSync(fake.config, config, { mode: 0o600 });
  const pin = crypto.createHash('sha256').update(fs.readFileSync(fake.binary)).digest('hex');
  let helper = null; let wrapperPid = null; let lookalike = null;
  try {
    ({ helper, wrapperPid } = await startSupervisorHelper({ userData: supervisorUserData, socketPath: supervisorSock, credentialsPath, binaryPath: supervisorBinary, pin }));
    await waitFor(() => row(wrapperPid)?.pgid === wrapperPid, 2000, 'supervisor watchdog start');
    const wrapperRow = row(wrapperPid);
    assert.ok(isOwnedTunnelRow(wrapperRow, { configPath: supervisorConfig, userData: supervisorUserData }), 'supervisor watchdog lost app-copy/config ownership marker: ' + JSON.stringify(wrapperRow));
    assert.ok(fs.readFileSync(supervisorConfig, 'utf8').includes('service: "unix:' + supervisorSock + '"'), 'real supervisor config did not retain the Unix-socket origin');
    const lookalikeConfig = path.join(fake.tunnel, 'different.yml');
    lookalike = await orphanChild(fake.binary, ['tunnel', '--config', lookalikeConfig, '--no-autoupdate', 'run', tunnelId]);
    await waitFor(() => Boolean(row(lookalike)), 1500, 'different-config look-alike start');
    assert.equal(isOwnedTunnelRow(row(lookalike), { configPath: fake.config, userData }), false, 'different-config look-alike matched the owned tunnel marker');
    const crashedAt = Date.now();
    process.kill(helper.pid, 'SIGKILL');
    await waitFor(() => gone(helper.pid), 1000, 'supervisor helper death');
    await waitFor(() => {
      const rows = groupRows(wrapperPid);
      return rows !== null && rows.length === 0;
    }, 6000, 'watchdog cleanup after supervisor helper SIGKILL');
    assert.equal(gone(lookalike), false, 'different-config look-alike was touched by watchdog cleanup');
    assert.ok(Date.now() - crashedAt <= 6000, 'watchdog cleanup exceeded the six-second bound');
  } finally {
    if (helper && !gone(helper.pid)) try { process.kill(helper.pid, 'SIGKILL'); } catch { /* gone */ }
    if (wrapperPid && row(wrapperPid)?.pgid === wrapperPid) try { process.kill(-wrapperPid, 'SIGKILL'); } catch { /* gone */ }
    if (lookalike && row(lookalike)?.pgid === lookalike) try { process.kill(-lookalike, 'SIGKILL'); } catch { /* gone */ }
    await Promise.all([
      helper ? waitFor(() => gone(helper.pid), 2000, 'supervisor helper cleanup').catch(() => undefined) : Promise.resolve(),
      wrapperPid ? waitFor(() => gone(wrapperPid), 2000, 'watchdog cleanup').catch(() => undefined) : Promise.resolve(),
      lookalike ? waitFor(() => gone(lookalike), 2000, 'look-alike cleanup').catch(() => undefined) : Promise.resolve(),
    ]);
  }
}

async function orphan(ctx) {
  if (process.platform !== 'darwin') {
    console.log('handoff bridge conformance: orphan: skipped (Darwin-only ps/reparenting semantics)');
    return;
  }
  const userData = ctx.make('orphan');
  const fake = fakeBinary(userData);
  const sock = socketPath(userData);
  const tunnelId = '123e4567-e89b-42d3-a456-426614174000';
  const credentialsPath = fakeCredentials(fake, tunnelId);
  fs.writeFileSync(fake.config, renderTunnelConfig({ tunnelId, hostname: HOST, credentialsPath, socketPath: sock }), { mode: 0o600 });
  const argv = ['tunnel', '--config', fake.config, '--no-autoupdate', 'run', tunnelId];
  const pid = await orphanChild(fake.binary, argv);
  const lookalike = await orphanChild(fake.binary, ['tunnel', '--config', path.join(fake.tunnel, 'different.yml'), '--no-autoupdate', 'run', tunnelId]);
  try {
    await waitFor(() => row(pid)?.ppid === 1 || row(pid)?.ppid === 0, 2000, 'orphan reparenting');
    const target = row(pid);
    assert.ok(target && isOwnedTunnelRow(target, { configPath: fake.config, userData }), 'orphan marker drifted');
    fs.writeFileSync(path.join(fake.tunnel, 'tunnel.pid.json'), JSON.stringify({ v: 1, pid, pgid: target.pgid, lstart: target.lstart, configPath: fake.config, createdAt: Date.now() }), { mode: 0o600 });
    const result = await reapOrphans({ userData, configPath: fake.config, parentPid: -1, wait: delay });
    assert.equal(result.reaped, 1, 'owned orphan was not reaped: ' + JSON.stringify(result));
    await waitFor(() => gone(pid), 6000, 'owned orphan death');
    assert.equal(gone(lookalike), false, 'different-config look-alike was touched');
  } finally {
    for (const child of [pid, lookalike]) {
      try { process.kill(-child, 'SIGKILL'); } catch { try { process.kill(child, 'SIGKILL'); } catch { /* gone */ } }
    }
    await Promise.all([pid, lookalike].map(child => waitFor(() => gone(child), 2000, 'orphan cleanup').catch(() => undefined)));
  }
}

async function suite(name, ctx, options, loaded) {
  const started = Date.now();
  if (name === 'wire') await wire(ctx, options, loaded);
  else if (name === 'oauth') await oauth(ctx, loaded);
  else if (name === 'drain') await drain(ctx, loaded);
  else if (name === 'push') await push();
  else if (name === 'abuse') await abuse(ctx);
  else if (name === 'soak') await soak(ctx, options, loaded);
  else if (name === 'tunnel') await tunnel(ctx);
  else if (name === 'orphan') await orphan(ctx);
  else die('unimplemented suite ' + name);
  console.log('handoff bridge conformance: ' + name + ': passed (' + (Date.now() - started) + 'ms)');
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) { console.log(help()); return; }
  const egress = installOutboundEgressGuard();
  let ctx = null;
  try {
    await loadLocalModules();
    const loaded = await sdk();
    ctx = context(options);
    egress.allowUnixRoot(ctx.root);
    for (const name of options.suite === 'all' ? SUITES : [options.suite]) await suite(name, ctx, options, loaded);
  } finally {
    try { ctx?.cleanup(); }
    finally {
      const attempts = egress.attempts();
      egress.restore();
      assert.deepEqual(attempts, [], 'the conformance harness attempted non-AF_UNIX outbound egress');
    }
  }
}

main().catch(error => {
  console.error('handoff bridge conformance failed: ' + (error?.stack || error?.message || String(error)));
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
