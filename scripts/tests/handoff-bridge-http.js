import { assert } from './testHelpers.js';
import { EventEmitter } from 'node:events';
import { createFakeClock } from './fixtures/handoff-bridge/fakeClock.js';
import { exchange, parseContentLength } from './fixtures/handoff-bridge/fakeHttp.js';
import { faultAt, withLeakCheck, withTimeout } from './fixtures/handoff-bridge/harness.js';
import { createPermitPool, createRequestHandler, isConnectorSource, sourceKey, sourcePrefix } from '../../electron/ipc/handoffBridge/http.js';
import { createListener } from '../../electron/ipc/handoffBridge/listener.js';
import { createSocketFsNet } from './fixtures/handoff-bridge/bridgeFixtures.js';
import { methodNotAllowed, notFound, sendHtml, sendJson, sendRedirect } from '../../electron/ipc/handoffBridge/respond.js';
import { KeyedBuckets, WireError, jsonToParams, makeBucket, mimeOf, parseForm, parseJsonObject, readBody } from '../../electron/ipc/handoffBridge/wire.js';

export default [
  {
    name: 'handoff bridge: http: listener rebinds through the bounded restart ladder',
    async run() {
      const fixture = createSocketFsNet(); const clock = createFakeClock(0); const servers = [];
      const httpModule = { createServer: () => {
        const events = new Map(); const server = { on: (event, listener) => events.set(event, listener), once() {}, off() {}, listen: (_options, ready) => { fixture.entries.set(fixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); ready(); }, close: done => done(), closeIdleConnections() {}, closeAllConnections() {}, events };
        servers.push(server); return server;
      } };
      const listener = createListener({ socketPath: fixture.socketPath, handler() {}, fsModule: fixture.fs, netModule: fixture.net, httpModule, timers: clock });
      await listener.start();
      servers[0].events.get('close')();
      for (let index = 0; index < 12; index++) await Promise.resolve();
      clock.advance(999); await Promise.resolve(); assert(servers.length === 1, 'restart must wait the first one-second backoff');
      clock.advance(1); for (let index = 0; index < 30; index++) await Promise.resolve();
      assert(servers.length === 2 && listener.accepting, 'unexpected close must rerun the complete bind sequence');
      await listener.stop();
    },
  },
  {
    name: 'handoff bridge: http: Expect preflight authorizes before sending 100 Continue',
    async run() {
      const fixture = createSocketFsNet(); const events = new Map(); const order = [];
      const server = { on: (event, listener) => events.set(event, listener), once() {}, off() {}, listen: (_options, ready) => { fixture.entries.set(fixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); ready(); }, close: done => done(), closeIdleConnections() {}, closeAllConnections() {} };
      const handler = async () => { order.push('body'); };
      handler.preflight = async () => { order.push('auth'); return true; };
      const listener = createListener({ socketPath: fixture.socketPath, handler, fsModule: fixture.fs, netModule: fixture.net, httpModule: { createServer: () => server } });
      await listener.start();
      await events.get('checkContinue')({}, { writeContinue: () => order.push('continue'), headersSent: false });
      assert(order.join(',') === 'auth,continue,body', 'Expect must authenticate before 100 Continue, then permit body consumption');
      await listener.stop();
    },
  },
  {
    name: 'handoff bridge: http: permit pools shed work and watchdog-release exactly once',
    run() {
      const clock = createFakeClock(0); const leaks = [];
      const pool = createPermitPool(1, { timers: clock, watchdogMs: 20, onLeak: () => leaks.push('leak') });
      const first = pool.acquire();
      assert(typeof first === 'function' && pool.acquire() === null && pool.held === 1, 'a full pool must shed rather than queue unbounded work');
      clock.advance(20);
      assert(pool.held === 0 && leaks.join(',') === 'leak', 'watchdog must release a stuck permit once');
      first();
      assert(pool.held === 0 && leaks.length === 1, 'late finally release after watchdog must be idempotent');
      const second = pool.acquire(); second();
      assert(pool.held === 0, 'ordinary finally release must leave no permit held');
      let zeroCleared = false;
      const zero = createPermitPool(1, { timers: { setTimeout: () => 0, clearTimeout: value => { zeroCleared = value === 0; } }, watchdogMs: 1 });
      zero.acquire()();
      const broken = createPermitPool(1, { timers: { setTimeout() { throw new Error('timer'); } }, watchdogMs: 1 });
      assert(zeroCleared && broken.acquire() === null && broken.held === 0, 'timer id zero and timer construction errors must not retain a permit');
      const noisy = createPermitPool(1, { timers: clock, watchdogMs: 1, onLeak() { throw new Error('reporting fault'); } });
      noisy.acquire(); clock.advance(1);
      assert(noisy.held === 0, 'a throwing leak reporter must not escape its timer or retain the permit');
    },
  },
  {
    name: 'handoff bridge: http: listener refuses a live socket and reclaims only a stale socket',
    async run() {
      const makeHttp = fixture => ({ createServer: () => ({ on() {}, once() {}, off() {}, listen: (_options, ready) => { fixture.entries.set(fixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); ready(); }, close: done => done(), closeIdleConnections() {}, closeAllConnections() {} }) });
      const live = createSocketFsNet({ existing: '/tmp/ic-handoff/b.sock', connect: 'live' });
      const liveListener = createListener({ socketPath: live.socketPath, handler() {}, fsModule: live.fs, netModule: live.net, httpModule: makeHttp(live) });
      let liveError;
      try { await liveListener.start(); } catch (error) { liveError = error; }
      assert(liveError?.code === 'socket_unavailable' && liveError.detail === 'in_use', 'a successful socket connect must refuse an existing live listener');
      const stale = createSocketFsNet({ existing: '/tmp/ic-handoff/b.sock', connect: 'missing' });
      const staleListener = createListener({ socketPath: stale.socketPath, handler() {}, fsModule: stale.fs, netModule: stale.net, httpModule: makeHttp(stale) });
      await staleListener.start();
      assert(staleListener.accepting, 'ECONNREFUSED stale socket must be unlinked and rebound through the injected listener');
      await staleListener.stop();
      for (const unsafe of [
        createSocketFsNet({ existing: '/tmp/ic-handoff/b.sock', uid: (process.getuid?.() ?? 0) + 1 }),
        createSocketFsNet({ existing: '/tmp/ic-handoff/b.sock', mode: 0o666 }),
      ]) {
        const refused = createListener({ socketPath: unsafe.socketPath, handler() {}, fsModule: unsafe.fs, netModule: unsafe.net, httpModule: makeHttp(unsafe) });
        let error; try { await refused.start(); } catch (caught) { error = caught; }
        assert(error?.detail === 'permission' && unsafe.entries.has(unsafe.socketPath), 'an unsafe pre-existing socket must be refused without unlinking it');
      }
    },
  },
  {
    name: 'handoff bridge: http: listener rejects an unsafe or overlong socket path before touching fs',
    run() {
      for (const [socketPath, detail] of [['relative.sock', 'bad_path'], ['/tmp/../bridge.sock', 'bad_path'], [`/${'x'.repeat(101)}`, 'path_too_long']]) {
        let error;
        try { createListener({ socketPath, handler() {} }); } catch (caught) { error = caught; }
        assert(error?.code === 'socket_unavailable' && error.detail === detail, 'socket paths must be validated before a bind attempt');
      }
    },
  },
  {
    name: 'handoff bridge: http: synchronous socket-inspection timeout and initial bind failure cannot revive a listener',
    async run() {
      const stale = createSocketFsNet({ existing: '/tmp/ic-handoff/b.sock' }); let connects = 0;
      const immediateTimers = { setTimeout(fn) { fn(); return 0; }, clearTimeout() {} };
      const timed = createListener({ socketPath: stale.socketPath, handler() {}, fsModule: stale.fs, netModule: { connect() { connects++; throw new Error('must not connect'); } }, httpModule: { createServer() { throw new Error('must not bind'); } }, timers: immediateTimers });
      let inspectError; try { await timed.start(); } catch (error) { inspectError = error; }
      assert(connects === 0 && inspectError?.detail === 'permission', 'a synchronous inspection timeout must settle before creating a client');
      const fixture = createSocketFsNet(); const clock = createFakeClock(0); const handlers = new Map(); const once = new Map();
      const failed = createListener({ socketPath: fixture.socketPath, handler() {}, fsModule: fixture.fs, netModule: fixture.net, timers: clock, httpModule: { createServer: () => ({ on: (event, callback) => handlers.set(event, callback), once: (event, callback) => once.set(event, callback), off: event => once.delete(event), listen: () => queueMicrotask(() => { const error = Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); handlers.get('error')?.(error); once.get('error')?.(error); }), close: done => done(), closeIdleConnections() {}, closeAllConnections() {} }) } });
      let bindError; try { await failed.start(); } catch (error) { bindError = error; }
      for (let index = 0; index < 4; index++) await Promise.resolve();
      assert(bindError?.detail === 'in_use' && clock.pendingCount() === 0 && !failed.accepting, 'an initial bind error must reject once without scheduling a surprise recovery');
    },
  },
  {
    name: 'handoff bridge: http: URL Host source and fetch metadata policy fail closed at the boundary',
    async run() {
      let authenticates = 0;
      const audit = [];
      const handler = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', mcp: async () => ({ status: 200, body: {} }), authenticate: async () => { authenticates++; return { linkId: 'L' }; }, audit: { write: entry => audit.push(entry) } });
      const absolute = await exchange(handler, { path: 'https://bridge.example.com/mcp', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert(absolute.status === 400 && absolute.readBytes === 0, 'absolute-form request targets must fail URL sanity before routing');
      const wrongMethod = await exchange(handler, { method: 'GET', path: '/mcp', body: '' });
      assert(wrongMethod.status === 405 && authenticates === 1, 'MCP must authenticate before rejecting its method');
      const observed = await exchange(handler, { path: '/mcp', headers: { 'content-type': 'application/json', origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
      assert(observed.status === 200 && audit.length === 1 && audit[0].ev === 'origin_seen' && audit[0].origin === 'foreign.example', 'authenticated server metadata is observed, not blocked, before the production policy switch');
      assert(sourceKey({ headers: { 'cf-connecting-ip': '999.999.999.999' } }) === 'unknown', 'invalid IPv4 must not create an unbounded bucket key');
      assert(sourceKey({ headers: { 'cf-connecting-ip': '2001:db8:0:0:7::1' } }) === '2001:db8:0:0::/64', 'IPv6 keys must reduce exactly to their first /64');
      const disabled = createRequestHandler({ hostname: 'bridge.example.com', accepting: () => false, mcp: async () => ({ status: 200, body: {} }) });
      const disabledWrongHost = await exchange(disabled, { method: 'GET', path: '/.well-known/openid-configuration', headers: { host: 'localhost:1234' }, body: '' });
      const disabledValid = await exchange(disabled, { method: 'GET', path: '/.well-known/openid-configuration', body: '' });
      const disabledUnknown = await exchange(disabled, { path: '/unknown', body: '' });
      assert(disabledWrongHost.status === 421 && disabledValid.status === 503 && disabledUnknown.status === 503, 'URL and Host then Origin/quiesce must precede unknown-route rejection');
    },
  },
  {
    name: 'handoff bridge: http: listener owns only a verified injected Unix socket',
    async run() {
      const fixture = createSocketFsNet();
      const events = new Map();
      const server = {
        on: (event, listener) => { events.set(event, listener); },
        once: (event, listener) => { if (event === 'error') events.set(event, listener); },
        off: event => events.delete(event),
        listen: (_options, ready) => { fixture.entries.set(fixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); ready(); },
        close: done => done(), closeIdleConnections() {}, closeAllConnections() {},
      };
      const listener = createListener({ socketPath: fixture.socketPath, handler() {}, fsModule: fixture.fs, netModule: fixture.net, httpModule: { createServer: () => server } });
      await listener.start();
      assert(listener.accepting && server.maxConnections === 256 && events.has('checkContinue') && events.has('upgrade') && events.has('connect'), 'only the listener must configure socket limits and close alternate HTTP transports');
      for (const event of ['upgrade', 'connect']) {
        let destroyed = false;
        events.get(event)({}, { destroy() { destroyed = true; } });
        assert(destroyed, `${event} transports must be destroyed without dispatch`);
      }
      await listener.stop();
      assert(!fixture.entries.has(fixture.socketPath), 'listener stop must unlink only its owned socket');
    },
  },
  {
    name: 'handoff bridge: http: listener cleans a failed post-bind socket and cannot revive after stop races start',
    async run() {
      const fixture = createSocketFsNet();
      const badFs = { ...fixture.fs, chmodSync: target => { fixture.entries.get(target).mode = 0o644; } };
      const makeServer = () => ({ on() {}, once() {}, off() {}, listen: (_opts, ready) => { fixture.entries.set(fixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); ready(); }, close: done => done(), closeIdleConnections() {}, closeAllConnections() {} });
      const broken = createListener({ socketPath: fixture.socketPath, handler() {}, fsModule: badFs, netModule: fixture.net, httpModule: { createServer: makeServer } });
      let failure; try { await broken.start(); } catch (error) { failure = error; }
      assert(failure?.detail === 'permission' && !fixture.entries.has(fixture.socketPath), 'a post-listen permission failure must close and unlink only the newly created socket');
      const raceFixture = createSocketFsNet(); let ready;
      const listener = createListener({ socketPath: raceFixture.socketPath, handler() {}, fsModule: raceFixture.fs, netModule: raceFixture.net, httpModule: { createServer: () => ({ on() {}, once() {}, off() {}, listen: (_opts, callback) => { ready = () => { raceFixture.entries.set(raceFixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); callback(); }; }, close: done => done(), closeIdleConnections() {}, closeAllConnections() {} }) } });
      const starting = listener.start();
      for (let i = 0; i < 8 && !ready; i++) await Promise.resolve();
      await listener.stop(); ready(); await starting;
      assert(!listener.accepting && !raceFixture.entries.has(raceFixture.socketPath), 'stop during bind must invalidate the bind generation and leave no owned socket');
    },
  },
  {
    name: 'handoff bridge: http: listener emits a terminal restart status and fixed client-error headers',
    async run() {
      const clock = createFakeClock(0); const notices = []; const fixture = createSocketFsNet(); const exposed = new Map(); let attempt = 0;
      const ladder = createListener({ socketPath: fixture.socketPath, handler() {}, fsModule: fixture.fs, netModule: fixture.net, timers: clock, onRestart: notice => notices.push(notice), httpModule: { createServer: () => {
        const id = ++attempt; const handlers = new Map(); const once = new Map(); if (id === 1) exposed.set('handlers', handlers);
        return {
          on: (event, callback) => handlers.set(event, callback), once: (event, callback) => once.set(event, callback), off: event => once.delete(event),
          listen: (_opts, ready) => { if (id === 1) { fixture.entries.set(fixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); ready(); } else { const error = Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); queueMicrotask(() => { handlers.get('error')?.(error); once.get('error')?.(error); }); } },
          close: done => done(), closeIdleConnections() {}, closeAllConnections() {},
        };
      } } });
      await ladder.start(); exposed.get('handlers').get('close')();
      for (const delay of [1_000, 5_000, 30_000]) { for (let i = 0; i < 12; i++) await Promise.resolve(); clock.advance(delay); for (let i = 0; i < 24; i++) await Promise.resolve(); }
      assert(notices.some(notice => notice.terminal === true && notice.ok === false), 'three failed restarts must report an explicit terminal listener state');
      const clientError = exposed.get('handlers').get('clientError');
      const captureClientError = error => {
        const socket = { end: (text, done) => { socket.text = text; done?.(); }, destroy() { socket.destroyed = true; } };
        clientError(error, socket);
        return socket;
      };
      // clientError is server-level; fake HTTP exposes it without binding a socket.
      const overflow = captureClientError(Object.assign(new Error('untrusted parser bytes'), { code: 'HPE_HEADER_OVERFLOW' }));
      const parser = captureClientError(Object.assign(new Error('untrusted parser bytes'), { code: 'HPE_INVALID_METHOD' }));
      assert(overflow.destroyed && overflow.text === 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 0\r\n\r\n', 'header overflow must use the fixed 431 parser response bytes');
      assert(parser.destroyed && parser.text === 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 0\r\n\r\n' && !parser.text.includes('untrusted parser bytes'), 'all non-overflow parser errors must use fixed unreflected 400 response bytes');
      await ladder.stop();
    },
  },
  {
    name: 'handoff bridge: http: listener methods contain timer and quiesced-response port faults',
    async run() {
      const fixture = createSocketFsNet(); const clock = createFakeClock(0); let requestListener; let closeListener;
      const timers = {
        setTimeout: clock.setTimeout,
        clearTimeout() { throw new Error('clear fault'); },
      };
      const server = {
        on(event, callback) { if (event === 'close') closeListener = callback; }, once() {}, off() {},
        listen(_options, ready) { fixture.entries.set(fixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); ready(); },
        close(done) { done?.(); }, closeIdleConnections() {}, closeAllConnections() {},
      };
      const listener = createListener({
        socketPath: fixture.socketPath,
        handler() {},
        fsModule: fixture.fs,
        netModule: fixture.net,
        timers,
        httpModule: { createServer(_options, callback) { requestListener = callback; return server; } },
      });
      await listener.start();
      closeListener();
      for (let index = 0; index < 8; index++) await Promise.resolve();
      await listener.stop();
      let destroyed = false;
      await requestListener({ headers: {}, once() {} }, {
        setHeader() { throw new Error('response fault'); },
        destroy() { destroyed = true; },
      });
      assert(destroyed && !listener.accepting, 'stop and a quiesced request must never reject when injected timer/response ports throw');
    },
  },
  {
    name: 'handoff bridge: http: self-probe accepts only a bounded exact resource document',
    async run() {
      const runProbe = async ({ statusCode = 200, body = '{"resource":"https://bridge.example.com/mcp"}', headers = {}, timeout = false } = {}) => {
        const fixture = createSocketFsNet(); const clock = createFakeClock(0); let request; let options;
        const server = { on() {}, once() {}, off() {}, listen: (_opts, ready) => { fixture.entries.set(fixture.socketPath, { type: 'socket', uid: process.getuid?.() ?? 0, mode: 0o600 }); ready(); }, close: done => done(), closeIdleConnections() {}, closeAllConnections() {} };
        const httpModule = {
          createServer: () => server,
          request(nextOptions, callback) {
            options = nextOptions;
            request = new EventEmitter();
            request.destroy = () => { request.destroyed = true; };
            request.setTimeout = (_ms, onTimeout) => { request.onTimeout = onTimeout; };
            request.end = () => {
              if (timeout) return;
              queueMicrotask(() => {
                const response = new EventEmitter(); Object.assign(response, { statusCode, headers });
                callback(response);
                queueMicrotask(() => { response.emit('data', body); response.emit('end'); });
              });
            };
            return request;
          },
        };
        const listener = createListener({ socketPath: fixture.socketPath, handler() {}, fsModule: fixture.fs, netModule: fixture.net, httpModule, timers: clock });
        await listener.start();
        const probing = listener.selfProbe({ hostname: 'bridge.example.com' });
        if (timeout) clock.advance(2_000);
        const result = await probing;
        await listener.stop();
        return { result, request, options };
      };
      const good = await runProbe();
      assert(good.result.ok && good.options.path === '/.well-known/oauth-protected-resource/mcp', 'only an exact 200 metadata resource document may prove the local listener');
      for (const rejected of [
        await runProbe({ statusCode: 204 }),
        await runProbe({ body: '{"resource":"https://bridge.example.com/mcp/other"}' }),
        await runProbe({ body: 'not json' }),
        await runProbe({ body: `{"resource":"https://bridge.example.com/mcp","padding":"${'x'.repeat(16 * 1024)}"}` }),
      ]) assert(!rejected.result.ok && rejected.result.code === 'socket_unavailable' && rejected.request.destroyed, 'wrong status, resource, JSON, or an oversized response must fail with the fixed local code');
      const timedOut = await runProbe({ timeout: true });
      assert(!timedOut.result.ok && timedOut.request.destroyed, 'a stalled self-probe must abort through its bounded deadline');
    },
  },
  {
    name: 'handoff bridge: http: host route and bearer checks reject before body consumption',
    async run() {
      const mcp = async () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
      const handler = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', mcp, authenticate: async () => { throw new Error('no token'); } });
      const unknown = await exchange(handler, { path: '/not-a-route', body: 'never parse' });
      assert(unknown.status === 404 && unknown.readBytes === 0, 'unknown paths must return before body read');
      const wrongHost = await exchange(handler, { path: '/mcp', headers: { host: 'localhost:43193' }, body: '{}' });
      assert(wrongHost.status === 421 && wrongHost.readBytes === 0 && wrongHost.headers.connection === 'close', 'loopback host must be rejected and closed before body read');
      const unauthenticated = await exchange(handler, { path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert(unauthenticated.status === 401 && unauthenticated.readBytes === 0 && unauthenticated.headers['www-authenticate'].includes('resource_metadata'), 'bearer challenge must precede MCP body consumption');
      const presented = await exchange(handler, { path: '/mcp', headers: { 'content-type': 'application/json', authorization: 'Bearer garbage' }, body: '{}' });
      assert(presented.headers['www-authenticate'].includes('error="invalid_token"'), 'a presented bearer must receive the RFC invalid-token challenge parameter');
      assert(unauthenticated.headers.connection === 'close' && unauthenticated.readBytes === 0, 'a 401 challenge must close without consuming an unread request body');
      const unreadReq = new EventEmitter(); let unreadDestroyed = false;
      Object.assign(unreadReq, { url: '/mcp', method: 'POST', headers: { host: 'bridge.example.com', 'content-type': 'application/json', 'content-length': '2' }, rawHeaders: ['host', 'bridge.example.com'], complete: true, readableEnded: false, destroy() { unreadDestroyed = true; } });
      const unreadRes = new EventEmitter(); Object.assign(unreadRes, { headersSent: false, setHeader() {}, writeHead() { this.headersSent = true; }, end() { this.emit('finish'); } });
      await handler(unreadReq, unreadRes);
      assert(unreadDestroyed, 'the fixed 401 must destroy the unread body only after its response finishes');
    },
  },
  {
    name: 'handoff bridge: http: Host cardinality is exact and forwarded host is ignored',
    async run() {
      let oauthCalls = 0;
      const handler = createRequestHandler({ hostname: 'bridge.example.com', mcp: async () => ({ status: 200, body: {} }), oauth: { handle: async (_req, res) => { oauthCalls++; res.writeHead(200); res.end(); } } });
      const invoke = async ({ headers, rawHeaders }) => {
        const req = new EventEmitter(); Object.assign(req, { url: '/.well-known/openid-configuration', method: 'GET', headers, rawHeaders, complete: true, destroy() {} });
        let status = 0;
        const res = new EventEmitter(); Object.assign(res, { headersSent: false, writableEnded: false, setHeader() {}, writeHead(value) { status = value; this.headersSent = true; }, end() { this.writableEnded = true; this.emit('finish'); } });
        await handler(req, res); return status;
      };
      assert(await invoke({ headers: {}, rawHeaders: [] }) === 421, 'a missing Host must be refused');
      assert(await invoke({ headers: { host: 'bridge.example.com' }, rawHeaders: ['Host', 'bridge.example.com', 'host', 'bridge.example.com'] }) === 421, 'duplicate Host fields must be refused');
      assert(await invoke({ headers: { host: 'bridge.example.com', 'x-forwarded-host': 'attacker.example' }, rawHeaders: ['Host', 'bridge.example.com', 'X-Forwarded-Host', 'attacker.example'] }) === 200 && oauthCalls === 1, 'X-Forwarded-Host must not override the sole public Host');
    },
  },
  {
    name: 'handoff bridge: http: browser Origin policy is strict only on authorize POST',
    async run() {
      const handler = createRequestHandler({ hostname: 'bridge.example.com', mcp: async () => ({ status: 200, body: {} }), oauth: { handle: async (_req, res) => { res.writeHead(200, { 'content-length': '0' }); res.end(); } } });
      const foreignPost = await exchange(handler, { method: 'POST', path: '/oauth/authorize', headers: { origin: 'https://chatgpt.com', 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
      const authorizeGet = await exchange(handler, { method: 'GET', path: '/oauth/authorize', headers: { origin: 'https://chatgpt.com', 'sec-fetch-site': 'cross-site' }, body: '' });
      const wellKnown = await exchange(handler, { method: 'GET', path: '/.well-known/openid-configuration', headers: { origin: 'https://chatgpt.com', 'sec-fetch-site': 'same-site' }, body: '' });
      assert(foreignPost.status === 403 && authorizeGet.status === 200 && wellKnown.status === 200, 'foreign browser metadata must fail authorize POST but remain allowed on public GET routes');
    },
  },
  {
    name: 'handoff bridge: http: authenticated MCP body reaches only the authenticated dispatcher',
    async run() {
      let grant;
      const handler = createRequestHandler({
        hostname: 'bridge.example.com', sourcePolicy: 'off',
        authenticate: async () => ({ linkId: 'safe-link', clientKind: 'chatgpt' }),
        mcp: async (body, options) => { grant = options.grant; return { status: 200, body: { jsonrpc: '2.0', id: body.id, result: { ok: true } } }; },
      });
      const result = await exchange(handler, { path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":9,"method":"ping"}' });
      assert(result.status === 200 && JSON.parse(result.body).result.ok && grant.linkId === 'safe-link', 'authenticated request must dispatch with the grant, without a token copy');
    },
  },
  {
    name: 'handoff bridge: http: client close aborts an MCP hold through the port signal',
    async run() {
      let seen; let release;
      const handler = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', authenticate: async () => ({ linkId: 'grant' }), mcp: async (_body, { signal }) => {
        seen = signal; return new Promise(resolve => { release = resolve; });
      } });
      const req = new EventEmitter(); Object.assign(req, { url: '/mcp', method: 'POST', headers: { host: 'bridge.example.com', 'content-type': 'application/json', 'content-length': '41' }, rawHeaders: ['host', 'bridge.example.com'], complete: true, destroy() {} });
      const res = new EventEmitter(); Object.assign(res, { headersSent: false, writableFinished: false, setHeader() {}, writeHead() { this.headersSent = true; }, end() { this.writableFinished = true; } });
      const pending = handler(req, res);
      for (let index = 0; index < 8; index++) await Promise.resolve();
      req.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}')); req.emit('end');
      for (let index = 0; index < 8 && !seen; index++) await Promise.resolve();
      res.emit('close'); release({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }); await pending;
      assert(seen?.aborted === true, 'a client close must abort the MCP hold signal before the app result returns');
    },
  },
  {
    name: 'handoff bridge: http: aggregate limiter charges every rotating credential-less source',
    async run() {
      const handler = createRequestHandler({ hostname: 'bridge.example.com', mcp: async () => ({ status: 200, body: {} }), oauth: { handle: async (_req, res) => { res.writeHead(200, { 'content-length': '0' }); res.end(); } } });
      let limited = 0;
      for (let index = 0; index < 205; index++) {
        const result = await exchange(handler, { method: 'GET', path: '/.well-known/openid-configuration', headers: { 'cf-connecting-ip': `2001:db8:${index.toString(16)}:0::1` }, body: '' });
        if (result.status === 429) limited++;
      }
      assert(limited > 0, 'the aggregate budget must drain even when every request has a fresh source key');
    },
  },
  {
    name: 'handoff bridge: http: a known expired bearer uses its grant bucket, never anonymous buckets',
    async run() {
      let anonymous = 0;
      const expired = new Error('expired'); expired.knownFamily = true; expired.linkId = 'durable-link'; expired.presented = true;
      const handler = createRequestHandler({ hostname: 'bridge.example.com', counters: { increment: name => { if (name === 'mcp_anon') anonymous++; } }, authenticate: async () => { throw expired; }, mcp: async () => ({ status: 200, body: {} }) });
      const result = await exchange(handler, { path: '/mcp', headers: { authorization: 'Bearer stale', 'content-type': 'application/json' }, body: '{}' });
      assert(result.status === 401 && anonymous === 0 && result.headers['www-authenticate'].includes('error="invalid_token"'), 'known-family expired credentials must be isolated from anonymous source/aggregate accounting');
    },
  },
  {
    name: 'handoff bridge: http: MCP protocol failures stay JSON-RPC and anonymous 401 permits live through response completion',
    async run() {
      const valid = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', authenticate: async () => ({ linkId: 'grant' }), mcp: async () => ({ status: 200, body: {} }) });
      const wrongType = await exchange(valid, { path: '/mcp', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert(wrongType.status === 415 && JSON.parse(wrongType.body).error.code === -32000, 'MCP content-type failures must use the JSON-RPC error envelope');
      const now = () => 0;
      const limited = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', now, authenticate: async () => ({ linkId: 'grant' }), mcp: async () => ({ status: 200, body: {} }) });
      let last;
      for (let index = 0; index < 61; index++) last = await exchange(limited, { path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
      assert(last.status === 429 && JSON.parse(last.body).error.code === -32000 && last.headers['retry-after'], 'per-grant throttling must be JSON-RPC with Retry-After');
      const held = createRequestHandler({ hostname: 'bridge.example.com', authenticate: async () => { throw new Error('none'); }, mcp: async () => ({ status: 200, body: {} }) });
      const responses = [];
      for (let index = 0; index < 16; index++) {
        const req = new EventEmitter(); Object.assign(req, { url: '/mcp', method: 'POST', headers: { host: 'bridge.example.com', 'content-type': 'application/json' }, rawHeaders: ['host', 'bridge.example.com'], complete: true, destroy() {} });
        const res = new EventEmitter(); Object.assign(res, { headersSent: false, setHeader() {}, writeHead() { this.headersSent = true; }, end() {} });
        await held(req, res); responses.push(res);
      }
      const overflowReq = new EventEmitter(); Object.assign(overflowReq, { url: '/mcp', method: 'POST', headers: { host: 'bridge.example.com' }, rawHeaders: ['host', 'bridge.example.com'], complete: true, destroy() {} });
      let status = 0; const overflowRes = { headersSent: false, on() {}, once() {}, setHeader() {}, writeHead(value) { status = value; this.headersSent = true; }, end() {} };
      await held(overflowReq, overflowRes);
      responses.forEach(response => response.emit('finish'));
      assert(status === 503, 'anonymous 401 work must retain its separate permit until response completion');
    },
  },
  {
    name: 'handoff bridge: http: injected accounting and outer validation failures return fixed 500 without rejection',
    async run() {
      const throwingCounter = createRequestHandler({ hostname: 'bridge.example.com', counters: { increment() { throw new Error('counter'); } }, mcp: async () => ({ status: 200, body: {} }) });
      const failure = await exchange(throwingCounter, { method: 'GET', path: '/.well-known/openid-configuration', headers: { host: 'wrong.example' }, body: '' });
      assert(failure.status === 421 && !failure.body.toString('utf8').includes('counter'), 'a throwing anonymous counter must not alter or leak through its fixed response');
      const throwingGate = createRequestHandler({ hostname: 'bridge.example.com', accepting() { throw new Error('gate'); }, mcp: async () => ({ status: 200, body: {} }) });
      const gateFailure = await exchange(throwingGate, { method: 'GET', path: '/.well-known/openid-configuration', body: '' });
      assert(gateFailure.status === 500 && !gateFailure.body.toString('utf8').includes('gate'), 'outer handler errors must become fixed non-leaking 500 responses');
      const throwingAudit = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', audit: { write() { throw new Error('audit'); } }, authenticate: async () => ({ linkId: 'grant' }), mcp: async () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }) });
      const result = await exchange(throwingAudit, { path: '/mcp', headers: { 'content-type': 'application/json', origin: 'https://foreign.example' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
      assert(result.status === 200, 'best-effort audit failures must not affect an authenticated wire response');
      const partial = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', authenticate: async () => ({ linkId: 'grant' }), mcp: async () => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }) });
      const req = new EventEmitter(); Object.assign(req, { url: '/mcp', method: 'POST', headers: { host: 'bridge.example.com', 'content-type': 'application/json' }, rawHeaders: ['host', 'bridge.example.com'], complete: true, destroy() {} });
      let destroyed = false;
      const res = new EventEmitter(); Object.assign(res, { headersSent: false, writableEnded: false, setHeader() {}, writeHead() { this.headersSent = true; }, end() { throw new Error('partial response'); }, destroy() { destroyed = true; } });
      const pending = partial(req, res); for (let index = 0; index < 8; index++) await Promise.resolve();
      req.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}')); req.emit('end'); await pending;
      assert(destroyed && partial.pools.authPool.held === 0, 'a throw after response headers must close the stream and release every permit');
    },
  },
  {
    name: 'handoff bridge: http: responders are no-store and never CORS',
    async run() {
      for (const [handler, expected] of [
        [(req, res) => sendJson(res, 201, { ok: true }), { status: 201, type: 'application/json', body: '{"ok":true}' }],
        [(req, res) => sendHtml(res, 200, '<p>ok</p>', "default-src 'none'"), { status: 200, type: 'text/html', body: '<p>ok</p>' }],
        [(req, res) => sendRedirect(res, 'https://example.com/cb', [['state', 'a b'], ['skip', null]]), { status: 302, type: null, body: '' }],
        [(req, res) => methodNotAllowed(res, 'POST'), { status: 405, type: 'application/json', body: '' }],
        [(req, res) => notFound(res), { status: 404, type: 'application/json', body: '' }],
      ]) {
        const result = await exchange(handler);
        assert(result.status === expected.status, 'responder status must be preserved');
        if (expected.type) assert(result.headers['content-type'].startsWith(expected.type), 'responder content type must be explicit');
        if (expected.body) assert(result.body.toString('utf8') === expected.body, 'responder bytes must match content length');
        assert(result.headers['cache-control'] === 'no-store', 'responder must not be cacheable');
        assert(result.headers['x-content-type-options'] === 'nosniff', 'every responder, including redirects, must nosniff');
        assert(/^\d+$/.test(result.headers['content-length'] || ''), 'every responder must declare an explicit content length');
        assert(!Object.keys(result.headers).some(key => key.startsWith('access-control-')), 'responders must never set CORS headers');
      }
    },
  },
  {
    name: 'handoff bridge: http: wire parsers copy only known keys and reject malformed values',
    run() {
      const form = parseForm('a=first&a=second&resource=x&resource=x&plus=a+b');
      assert(form.values.a === 'first' && form.dups.has('a') && !form.dups.has('resource'), 'form repeats must preserve the first value');
      assert(form.values.plus === 'a b', 'form decoding must translate plus to space');
      let malformed = false;
      try { parseForm('bad=%ZZ'); } catch (error) { malformed = error instanceof WireError; }
      assert(malformed, 'malformed form encoding must produce a wire error');
      const parsed = parseJsonObject('{"safe":"yes","__proto__":{"polluted":true},"constructor":{"prototype":{"bad":true}}}', ['safe']);
      assert(parsed.safe === 'yes' && !Object.hasOwn(parsed, '__proto__') && !Object.hasOwn(parsed, 'constructor'), 'JSON parsing must copy known keys only');
      assert(({}).polluted === undefined && ({}).bad === undefined, 'prototype pollution must not reach Object.prototype');
      assert(jsonToParams('{"grant_type":"refresh_token","ignored":"x"}', ['grant_type']).grant_type === 'refresh_token', 'JSON params must retain allowed strings only');
      let wrongType = false;
      try { jsonToParams('{"grant_type":3}', ['grant_type']); } catch (error) { wrongType = error instanceof WireError; }
      assert(wrongType, 'non-string JSON parameters must fail closed');
      assert(mimeOf({ headers: { 'content-type': 'Application/JSON; charset=utf-8' } }) === 'application/json', 'mime parsing must be case insensitive');
    },
  },
  {
    name: 'handoff bridge: http: body caps, deadlines, drain and buckets are deterministic',
    async run() {
      const overDeclared = await exchange(async (req, res) => {
        try { await readBody(req, { capBytes: 4, timeoutMs: 50, response: res }); } catch (error) {
          assert(error.status === 413, 'declared oversize must be 413');
          res.writeHead(error.status, { connection: 'close', 'content-length': '0' }); res.end();
        }
      }, { body: '12345', connection: 'close' });
      await new Promise(resolve => setImmediate(resolve));
      assert(overDeclared.req.destroyed, 'anonymous declared oversize must send its response then destroy the request');
      const chunked = await exchange(async (req, res) => {
        try { await readBody(req, { capBytes: 4, timeoutMs: 50, response: res }); } catch (error) {
          assert(error.status === 413, 'chunked oversize must be 413');
          res.writeHead(error.status, { connection: 'close', 'content-length': '0' }); res.end();
        }
      }, { body: '12345', chunked: true, chunkSize: 1, connection: 'close' });
      await new Promise(resolve => setImmediate(resolve));
      assert(chunked.req.destroyed, 'chunked oversize must destroy the request');
      const clock = createFakeClock(0);
      const stalled = { headers: {}, complete: false, on() {}, destroy() { this.destroyed = true; } };
      const pending = readBody(stalled, { capBytes: 8, timeoutMs: 5, setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout });
      clock.advance(5);
      let timeout;
      try { await pending; } catch (error) { timeout = error; }
      assert(timeout?.status === 408 && stalled.destroyed, 'injected timeout must fail closed and destroy a stalled request');
      const listeners = {}; let cleared;
      const complete = { headers: {}, complete: true, on(event, callback) { listeners[event] = callback; }, destroy() {} };
      const finished = readBody(complete, { capBytes: 8, timeoutMs: 5, setTimeoutImpl: () => 0, clearTimeoutImpl: value => { cleared = value; } });
      listeners.end(); await finished;
      assert(cleared === 0, 'wire body completion must clear a numeric timer id zero');
      let now = 0;
      const bucket = makeBucket(1, 1, () => now);
      assert(bucket() === 0 && bucket() === 1, 'bucket must charge and report whole retry seconds');
      now = 1000;
      assert(bucket.peek() === 0 && bucket() === 0, 'bucket peek must not spend a refilled token');
      const keyed = new KeyedBuckets({ capacity: 1, perSecond: 1, now: () => now, maxKeys: 2 });
      keyed.get('a'); keyed.get('b'); keyed.get('a'); keyed.get('c');
      assert(keyed.size === 2 && !keyed.buckets.has('b') && keyed.evictionsInLastMinute() === 1, 'keyed buckets must evict least-recently-used keys');
    },
  },
  {
    name: 'handoff bridge: http: MCP maps chunk overflow and a stalled body to fixed non-5xx responses',
    async run() {
      const authenticated = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', authenticate: async () => ({ linkId: 'grant' }), mcp: async () => ({ status: 200, body: {} }) });
      const overflow = await exchange(authenticated, { path: '/mcp', headers: { 'content-type': 'application/json' }, chunked: true, chunkSize: 8192, body: 'x'.repeat(2 * 1024 * 1024 + 1) });
      assert(overflow.status === 413 && !overflow.body.toString('utf8').includes('server_error'), 'chunked MCP overflow must be a fixed 413, not a 500');
      const clock = createFakeClock(0); let status = 0; let text = '';
      const req = { url: '/mcp', method: 'POST', headers: { host: 'bridge.example.com', 'content-type': 'application/json', 'content-length': '2' }, rawHeaders: ['host', 'bridge.example.com'], complete: false, on(event, callback) { this[event] = callback; }, once() {}, destroy() { this.destroyed = true; } };
      const res = { headersSent: false, setHeader() {}, once() {}, writeHead(code) { status = code; this.headersSent = true; }, end(body = '') { text = String(body); } };
      const stalled = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', authenticate: async () => ({ linkId: 'stalled' }), mcp: async () => ({ status: 200, body: {} }), setTimeoutImpl: clock.setTimeout, clearTimeoutImpl: clock.clearTimeout });
      const pending = stalled(req, res);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      clock.advance(30_000); await pending;
      assert(status === 408 && text.includes('timed out') && req.destroyed && stalled.pools.authPool.held === 0 && stalled.pools.mcpBodyPool.held === 0, 'stalled MCP body must settle 408 and release both permits');
    },
  },
  {
    name: 'handoff bridge: http: in-process exchange preserves real request response semantics',
    async run() {
      const payload = '{"answer":"Ada Lovelace"}';
      const responseBody = 'accepted';
      const result = await withLeakCheck(() => withTimeout(exchange({
        async checkContinue(req, res) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          assert(Buffer.concat(chunks).toString('utf8') === payload, 'request chunks must reassemble byte-identically');
          res.writeHead(201, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': String(Buffer.byteLength(responseBody)),
            'cache-control': 'no-store',
          });
          res.end(responseBody);
        },
      }, {
        body: payload,
        chunkSize: 3,
        chunked: true,
        expectContinue: true,
        connection: 'close',
      }), 1000));
      assert(result.req.complete === true, 'the fake must preserve IncomingMessage complete semantics');
      assert(result.status === 201 && result.body.toString('utf8') === responseBody, 'ServerResponse bytes must be parsed exactly');
      assert(result.headers['content-length'] === String(responseBody.length), 'explicit response length must survive');
      assert(result.req.headers['transfer-encoding'] === 'chunked' && result.contentLength === null, 'chunked requests must not invent a content length');
      assert(result.readBytes === Buffer.byteLength(payload), 'body consumption must be observed by bytes');
      assert(result.observations.expectContinue && result.observations.connection === 'close', 'Expect and Connection controls must reach the handler');
    },
  },
  {
    name: 'handoff bridge: http: content length parser and request destruction fail closed',
    async run() {
      assert(parseContentLength({ 'content-length': '8192' }) === 8192, 'valid decimal content length must parse');
      for (const value of ['-1', '01', '1.5', 'NaN', '9007199254740992']) {
        assert(parseContentLength({ 'content-length': value }) === null, `invalid content length ${value} must fail closed`);
      }
      const result = await withTimeout(exchange((req, res) => {
        req.on('error', () => undefined);
        res.writeHead(499, { 'content-length': '0', connection: 'close' });
        res.end();
      }, { abort: true, connection: 'close' }), 1000);
      assert(result.observations.bodyDestroyed && result.destroyed, 'an early rejection must observe both body and connection destruction');
    },
  },
  {
    name: 'handoff bridge: http: fake clock orders timers and models ref unref clear and intervals',
    run: () => {
      const clock = createFakeClock(1000);
      const order = [];
      const cleared = clock.setTimeout(() => order.push('cleared'), 2);
      clock.clearTimeout(cleared);
      const later = clock.setTimeout(() => order.push('later'), 10).unref();
      clock.setTimeout(() => order.push('first'), 5);
      clock.setTimeout(() => order.push('second'), 5);
      let ticks = 0;
      const interval = clock.setInterval(() => { ticks++; if (ticks === 2) clock.clearInterval(interval); }, 3);
      assert(!later.hasRef() && clock.pendingRefed().length === 3, 'unref must affect only liveness bookkeeping');
      clock.advance(5);
      assert(order.join(',') === 'first,second' && ticks === 1, 'due timers must run by deadline then insertion order');
      clock.advance(5);
      assert(order.join(',') === 'first,second,later' && ticks === 2 && clock.pendingCount() === 0, 'interval clear and later timeout must settle deterministically');
    },
  },
  {
    name: 'handoff bridge: http: faultAt fails exactly one call in throw and reject modes',
    async run() {
      const calls = [];
      const base = { call: async value => { calls.push(value); return value; } };
      for (const mode of ['throw', 'reject']) {
        const injected = new Error(`fault-${mode}`);
        const wrapped = faultAt(base, 2, { mode, error: injected });
        assert(await wrapped.port.call(`${mode}-one`) === `${mode}-one`, 'first call must pass');
        let seen;
        try { await wrapped.port.call(`${mode}-two`); } catch (error) { seen = error; }
        assert(seen === injected, `${mode} fault must hit exactly the kth call`);
        assert(await wrapped.port.call(`${mode}-three`) === `${mode}-three`, 'calls after the injected fault must recover');
        assert(wrapped.count() === 3 && wrapped.calls.length === 3, 'fault sweep call accounting must be exact');
      }
      assert(calls.length === 4, 'the underlying port must run on every non-faulted call only');
    },
  },
  {
    name: 'handoff bridge: http: timeout helper uses injected timers and clears them',
    async run() {
      const clock = createFakeClock(0);
      let clears = 0;
      const pending = withTimeout(new Promise(() => {}), 25, {
        setTimeoutImpl: clock.setTimeout,
        clearTimeoutImpl: timer => { clears++; clock.clearTimeout(timer); },
        message: 'synthetic timeout',
      });
      clock.advance(25);
      let message = '';
      try { await pending; } catch (error) { message = error.message; }
      assert(message === 'synthetic timeout' && clears === 1 && clock.pendingCount() === 0, 'timeout must reject once and release its timer');
    },
  },
  {
    name: 'handoff bridge: http: full Expect preflight reserves only its own pool and refuses before Continue',
    async run() {
      const handler = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', authenticate: async () => ({ linkId: 'grant' }), mcp: async body => ({ status: 200, body: { jsonrpc: '2.0', id: body.id, result: {} } }), oauth: { handle: async (_req, res) => { res.writeHead(200, { 'content-length': '0' }); res.end(); } } });
      const rejected = await exchange({ checkContinue: (req, res) => handler.preflight(req, res) }, { expectContinue: true, path: '/mcp', headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) }, body: '' });
      assert(rejected.status === 413 && rejected.readBytes === 0, 'Expect MCP preflight must reject declared oversize before 100 Continue or a body read');
      const accepted = await exchange({ checkContinue: async (req, res) => { if (await handler.preflight(req, res)) await handler(req, res); } }, { expectContinue: true, path: '/oauth/authorize', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
      assert(accepted.status === 200 && handler.pools.anonBodyPool.held === 0, 'a preflight reservation must carry to dispatch and release exactly once');
      const noTokenHandler = createRequestHandler({ hostname: 'bridge.example.com', authenticate: async () => { throw new Error('missing'); }, mcp: async () => ({ status: 200, body: {} }) });
      const noToken = await exchange({ checkContinue: (req, res) => noTokenHandler.preflight(req, res) }, { expectContinue: true, path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert(noToken.status === 401 && noToken.readBytes === 0, 'Expect must authenticate before a client is invited to send MCP bytes');
    },
  },
  {
    name: 'handoff bridge: http: anonymous slow OAuth reservations cannot starve authenticated MCP',
    async run() {
      const handler = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', authenticate: async () => ({ linkId: 'grant' }), mcp: async body => ({ status: 200, body: { jsonrpc: '2.0', id: body.id, result: {} } }), oauth: { handle: async () => undefined } });
      const held = [];
      for (let i = 0; i < 3; i++) {
        const req = { url: '/oauth/authorize', method: 'POST', headers: { host: 'bridge.example.com', 'content-length': '7', 'cf-connecting-ip': `198.51.100.${i + 1}` }, rawHeaders: ['host', 'bridge.example.com'], once() {} };
        const res = { setHeader() {}, writeHead() {}, end() {} };
        assert(await handler.preflight(req, res), 'each distinct anonymous source may reserve one body permit');
        held.push(req);
      }
      const fourth = { url: '/oauth/authorize', method: 'POST', headers: { host: 'bridge.example.com', 'content-length': '7', 'cf-connecting-ip': '198.51.100.8' }, rawHeaders: ['host', 'bridge.example.com'], once() {} };
      let busyStatus = 0;
      assert(!(await handler.preflight(fourth, { setHeader() {}, writeHead(status) { busyStatus = status; }, end() {} })) && busyStatus === 503, 'the fourth slow anonymous body must shed without reading');
      const mcp = await exchange(handler, { path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
      assert(mcp.status === 200 && handler.pools.authPool.held === 0 && handler.pools.mcpBodyPool.held === 0, 'reserved MCP pools must remain available despite all anonymous body permits being held');
      for (const req of held) { req.__icHandoffPrepared.releaseSource(); req.__icHandoffPrepared.releaseBody(); }
    },
  },
  {
    name: 'handoff bridge: http: boundary faults release every MCP permit and anonymous calls never reach audit',
    async run() {
      const audit = [];
      for (const mode of ['throw', 'reject']) {
        const port = faultAt({ call: async body => ({ status: 200, body: { jsonrpc: '2.0', id: body.id, result: {} } }) }, 1, { mode, error: new Error('synthetic dispatch fault') });
        const handler = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', audit: { write: entry => audit.push(entry) }, authenticate: async () => ({ linkId: `grant-${mode}` }), mcp: body => port.port.call(body) });
        const first = await exchange(handler, { path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
        const second = await exchange(handler, { path: '/mcp', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":2,"method":"ping"}' });
        assert(first.status === 500 && second.status === 200 && handler.pools.authPool.held === 0 && handler.pools.mcpBodyPool.held === 0, `${mode} after an await must not strand MCP permits`);
      }
      const anonymous = createRequestHandler({ hostname: 'bridge.example.com', audit: { write: entry => audit.push(entry) }, authenticate: async () => { throw new Error('no bearer'); }, mcp: async () => ({ status: 200, body: {} }) });
      for (let i = 0; i < 500; i++) await exchange(anonymous, { path: '/mcp', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${i % 250}` }, body: '{}' });
      assert(audit.length === 0, 'five hundred anonymous requests must leave the security audit/ring identity unchanged');
    },
  },
  {
    name: 'handoff bridge: http: IPv6 LRU pressure switches rate policy to aggregate-only with a ledger entry',
    async run() {
      const audit = [];
      const handler = createRequestHandler({ hostname: 'bridge.example.com', audit: { write: entry => audit.push(entry) }, mcp: async () => ({ status: 200, body: {} }), oauth: { handle: async (_req, res) => { res.writeHead(200, { 'content-length': '0' }); res.end(); } } });
      for (let i = 0; i < 565; i++) {
        await exchange(handler, { method: 'GET', path: '/.well-known/openid-configuration', headers: { 'cf-connecting-ip': `2001:db8:${i.toString(16)}:0::1` }, body: '' });
      }
      assert(audit.some(entry => entry.ev === 'rate_lru_aggregate_only' && entry.kind === 'well_known'), 'more than fifty IPv6 LRU evictions in a minute must record aggregate-only mode');
    },
  },
  {
    name: 'handoff bridge: http: source policy canonicalizes /24 and /48 prefixes and honours pinned connector CIDRs',
    run() {
      assert(sourcePrefix({ headers: { 'cf-connecting-ip': '203.0.113.199' } }) === '203.0.113.0/24', 'IPv4 source policy must use the link-time /24');
      assert(sourcePrefix({ headers: { 'cf-connecting-ip': '2001:db8:1234:abcd::99' } }) === '2001:db8:1234::/48', 'IPv6 source policy must use the link-time /48');
      assert(sourcePrefix({ headers: { 'cf-connecting-ip': 'not-an-ip' } }) === 'unknown', 'invalid source headers must not become a policy prefix');
      assert(isConnectorSource({ headers: { 'cf-connecting-ip': '52.255.111.5' } }), 'the seeded OpenAI /28 must be recognized');
      assert(!isConnectorSource({ headers: { 'cf-connecting-ip': '52.255.111.16' } }), 'CIDR matching must not round a /28 up to a /24');
      assert(isConnectorSource({ headers: { 'cf-connecting-ip': '2001:db8:1234:ffff::1' } }, ['2001:db8:1234::/48']), 'IPv6 connector CIDRs must compare the requested prefix width');
      assert(!isConnectorSource({ headers: { 'cf-connecting-ip': '2001:db8:1235::1' } }, ['2001:db8:1234::/48']), 'IPv6 connector CIDRs must not accept an adjacent /48');
    },
  },
  {
    name: 'handoff bridge: http: source policy rejects before bearer/key work, preserves connector admission, and writes only closed ledger facts',
    async run() {
      const audit = []; let authenticates = 0; let securityCallbacks = 0; let mcpCalls = 0; let oauthCalls = 0;
      const oauth = {
        linkStatus: () => [{ linkId: 'grant', sources: ['203.0.113.0/24'] }],
        handle: async (_req, res) => { oauthCalls += 1; res.writeHead(200); res.end(); },
      };
      const handler = createRequestHandler({
        hostname: 'bridge.example.com', oauth, audit: { write: entry => audit.push(entry) },
        authenticate: async () => { authenticates += 1; securityCallbacks += 1; return { linkId: 'grant' }; },
        mcp: async () => { mcpCalls += 1; return { status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }; },
      });
      const deniedMcp = await exchange(handler, { path: '/mcp', headers: { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/json', authorization: 'Bearer malformed' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
      const deniedReuse = await exchange(handler, { path: '/mcp', headers: { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/json', authorization: 'Bearer reused-family-token' }, body: '{"jsonrpc":"2.0","id":2,"method":"ping"}' });
      const deniedToken = await exchange(handler, { path: '/oauth/token', headers: { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=synthetic' });
      const deniedRevoke = await exchange(handler, { path: '/oauth/revoke', headers: { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=synthetic' });
      assert(deniedMcp.status === 401 && deniedReuse.status === 401 && deniedToken.status === 401 && deniedRevoke.status === 401, 'a mismatched family source must receive the fixed 401 on every protected route');
      assert(authenticates === 0 && securityCallbacks === 0 && mcpCalls === 0 && oauthCalls === 0 && deniedMcp.readBytes === 0 && deniedReuse.readBytes === 0 && deniedToken.readBytes === 0 && deniedRevoke.readBytes === 0, 'wrong-prefix malformed and reused bearers must stop before authentication, security callbacks, key/reuse work, or a body read');
      const mismatches = audit.filter(entry => entry.ev === 'source_mismatch');
      assert(mismatches.length === 4 && mismatches.every(entry => Object.keys(entry).sort().join(',') === 'ev,route,statusClass' && ['mcp', 'oauth/token', 'oauth/revoke'].includes(entry.route) && entry.statusClass === '4xx') && !JSON.stringify(mismatches).includes('198.51.100'), 'pre-auth mismatch ledger entries must contain only enumerated event, route, and status-class facts, never an address or prefix');
      const samePrefix = await exchange(handler, { path: '/mcp', headers: { 'cf-connecting-ip': '203.0.113.88', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
      const connector = await exchange(handler, { path: '/mcp', headers: { 'cf-connecting-ip': '52.255.111.5', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
      assert(samePrefix.status === 200 && connector.status === 200, 'the link prefix and a pinned connector CIDR must be accepted');
      let multiAuthenticates = 0;
      const multiFamily = createRequestHandler({ hostname: 'bridge.example.com', oauth: { linkStatus: () => [{ linkId: 'first', sources: ['198.51.100.0/24'] }, { linkId: 'second', sources: ['203.0.113.0/24'] }] }, authenticate: async () => { multiAuthenticates += 1; return { linkId: 'first' }; }, mcp: async () => ({ status: 200, body: {} }) });
      const multi = await exchange(multiFamily, { path: '/mcp', headers: { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/json' }, body: '{}' });
      assert(multi.status === 401 && multiAuthenticates === 0 && multi.readBytes === 0, 'pre-auth source admission must use exactly one active family, never whichever family happens to match a prefix');
      let postAuthenticates = 0;
      const postAuthExact = createRequestHandler({ hostname: 'bridge.example.com', oauth: { linkStatus: () => [{ linkId: 'sole', sources: ['203.0.113.0/24'] }] }, authenticate: async () => { postAuthenticates += 1; return { linkId: 'other' }; }, mcp: async () => ({ status: 200, body: {} }) });
      assert((await exchange(postAuthExact, { path: '/mcp', headers: { 'cf-connecting-ip': '203.0.113.88', 'content-type': 'application/json' }, body: '{}' })).status === 401 && postAuthenticates === 1, 'the post-auth exact-family check must remain defensive after pre-auth admission');
      let dynamicPolicy = 'alert'; const dynamicAudit = [];
      const dynamic = createRequestHandler({ hostname: 'bridge.example.com', oauth, sourcePolicy: () => dynamicPolicy, audit: { write: entry => dynamicAudit.push(entry) }, authenticate: async () => ({ linkId: 'grant' }), mcp: async () => ({ status: 200, body: {} }) });
      assert((await exchange(dynamic, { path: '/mcp', headers: { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/json' }, body: '{}' })).status === 200 && dynamicAudit.every(entry => !('source' in entry)), 'dynamic alert records only safe facts but continues');
      dynamicPolicy = 'off';
      assert((await exchange(dynamic, { path: '/mcp', headers: { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/json' }, body: '{}' })).status === 200, 'dynamic off disables source enforcement without rebuilding the handler');
      let rePairCalls = 0;
      const rePair = createRequestHandler({ hostname: 'bridge.example.com', oauth: { linkStatus: () => [{ revoked: true, sources: ['203.0.113.0/24'] }], handle: async (_req, res) => { rePairCalls += 1; res.writeHead(200); res.end(); } }, mcp: async () => ({ status: 200, body: {} }) });
      const renewed = await exchange(rePair, { path: '/oauth/token', headers: { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=synthetic' });
      assert(renewed.status === 200 && rePairCalls === 1, 'only active families may constrain a replacement code exchange');
    },
  },
  {
    name: 'handoff bridge: http: an invalid bearer from an admitted source never creates a source ledger entry',
    async run() {
      let policyCalls = 0; const audit = [];
      const handler = createRequestHandler({
        hostname: 'bridge.example.com', sourcePolicy: () => { policyCalls += 1; return 'enforce'; },
        oauth: { linkStatus: () => [{ linkId: 'grant', sources: ['203.0.113.0/24'] }] },
        authenticate: async () => { throw new Error('invalid bearer'); }, audit: { write: entry => audit.push(entry) },
        mcp: async () => ({ status: 200, body: {} }),
      });
      const missing = await exchange(handler, { path: '/mcp', headers: { 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json' }, body: '{}' });
      const malformed = await exchange(handler, { path: '/mcp', headers: { 'cf-connecting-ip': '203.0.113.9', authorization: 'Bearer malformed', 'content-type': 'application/json' }, body: '{}' });
      assert(missing.status === 401 && malformed.status === 401 && policyCalls === 2, 'source admission must run before bearer handling even when the bearer is absent or invalid');
      assert(!audit.some(entry => entry.ev === 'source_mismatch'), 'an invalid bearer from an admitted source must not create source-policy ledger noise');
    },
  },
  ...[
    '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/openid-configuration', '/.well-known/openid-configuration/mcp',
    '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
    '/oauth/authorize', '/oauth/token', '/oauth/revoke',
  ].map(path => ({
    name: `handoff bridge: http: public route ${path} reaches only the OAuth port`,
    async run() {
      let received = '';
      const handler = createRequestHandler({ hostname: 'bridge.example.com', mcp: async () => ({ status: 200, body: {} }), oauth: { handle: async (_req, res, pathname) => { received = pathname; res.writeHead(200, { 'content-length': '0' }); res.end(); } } });
      const method = path === '/oauth/token' || path === '/oauth/revoke' ? 'POST' : 'GET';
      const result = await exchange(handler, { method, path, body: '' });
      assert(result.status === 200 && received === path, 'each allow-listed OAuth route must dispatch exactly once to its port');
    },
  })),
  ...[
    ['exact host', 'bridge.example.com', 200], ['TLS port', 'bridge.example.com:443', 200], ['case and dot', 'BRIDGE.EXAMPLE.COM.', 200],
    ['wrong port', 'bridge.example.com:43193', 421], ['loopback', 'localhost:43193', 421], ['IP literal', '127.0.0.1:43193', 421],
  ].map(([label, host, expected]) => ({
    name: `handoff bridge: http: public Host ${label}`,
    async run() {
      const handler = createRequestHandler({ hostname: 'bridge.example.com', mcp: async () => ({ status: 200, body: {} }), oauth: { handle: async (_req, res) => { res.writeHead(200, { 'content-length': '0' }); res.end(); } } });
      const result = await exchange(handler, { method: 'GET', path: '/.well-known/openid-configuration', headers: { host }, body: '' });
      assert(result.status === expected, 'only the configured public Host and explicit TLS port are valid');
    },
  })),
  ...[
    ['GET', '/oauth/token'], ['OPTIONS', '/mcp'], ['DELETE', '/oauth/revoke'], ['POST', '/.well-known/openid-configuration'],
    ['PUT', '/oauth/authorize'], ['PATCH', '/oauth/token'], ['HEAD', '/oauth/authorize'], ['OPTIONS', '/oauth/revoke'],
  ].map(([method, path]) => ({
    name: `handoff bridge: http: wrong method ${method} ${path} closes before body`,
    async run() {
      const handler = createRequestHandler({ hostname: 'bridge.example.com', sourcePolicy: 'off', mcp: async () => ({ status: 200, body: {} }), authenticate: async () => ({ linkId: 'grant' }), oauth: {} });
      const result = await exchange(handler, { method, path, body: 'unread' });
      assert(result.status === 405 && result.readBytes === 0 && result.headers.connection === 'close', 'wrong methods must not read a public request body');
    },
  })),
  ...[
    ['foreign Origin enforce', { origin: 'https://foreign.example' }, 'enforce', 403],
    ['own Origin enforce', { origin: 'https://bridge.example.com' }, 'enforce', 200],
    ['foreign fetch enforce', { 'sec-fetch-site': 'cross-site' }, 'enforce', 403],
    ['same-site fetch enforce', { 'sec-fetch-site': 'same-site' }, 'enforce', 403],
    ['foreign Origin observe', { origin: 'https://foreign.example' }, 'observe', 200],
    ['foreign fetch observe', { 'sec-fetch-site': 'cross-site' }, 'observe', 200],
  ].map(([label, headers, mode, expected]) => ({
    name: `handoff bridge: http: server metadata ${label}`,
    async run() {
      const handler = createRequestHandler({ hostname: 'bridge.example.com', originServerRoutes: mode, mcp: async () => ({ status: 200, body: {} }), oauth: { handle: async (_req, res) => { res.writeHead(200, { 'content-length': '0' }); res.end(); } } });
      const result = await exchange(handler, { method: 'POST', path: '/oauth/token', headers, body: '' });
      assert(result.status === expected, 'server route Origin and Sec-Fetch policy must follow its explicit mode');
    },
  })),
  ...[
    '203.0.113.1', '198.51.100.7', '192.0.2.3', '8.8.8.8', '1.1.1.1', '52.255.111.5',
    '2001:db8::1', '2001:db8:0:0::2', '2001:db8:0:1::2', '2606:4700:4700::1111',
    '2606:4700:4700:0:abcd::1', '::1', '::', 'fe80::1', 'not-an-ip', '999.999.999.999',
    '2001:db8:1:2:3:4:5:6', '2001:db8:1:2::6', '2001:db8:1:3::6', 'fd00::1',
  ].map(value => ({
    name: `handoff bridge: http: source key is bounded for ${value}`,
    run() {
      const key = sourceKey({ headers: { 'cf-connecting-ip': value } });
      assert(key === 'unknown' || key === value || key.endsWith('::/64'), 'source bucket keys must be canonical IP-only values or unknown');
    },
  })),
];
