import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { CONSTANTS } from './constants.js';

const SOCKET_PATH_MAX_BYTES = CONSTANTS.SOCKET_PATH_MAX_BYTES;
const SOCKET_MODE = CONSTANTS.SOCKET_MODE_OCTAL;
const DIRECTORY_MODE = CONSTANTS.BRIDGE_DIRECTORY_MODE_OCTAL;
const RESTART_DELAYS = [1_000, 5_000, 30_000];
const DEFAULT_DRAIN_MS = 10_000;
const SELF_PROBE_TIMEOUT_MS = 2_000;
const SELF_PROBE_MAX_BYTES = 16 * 1024;
const fixedUnavailable = '{"error":"temporarily_unavailable","error_description":"The handoff bridge is unavailable."}';
const fixedServerError = '{"error":"server_error","error_description":"The handoff bridge could not complete that request."}';

function unavailable(detail) { const error = new Error('The bridge socket is unavailable.'); error.code = 'socket_unavailable'; error.detail = detail; return error; }
const mode = stat => stat.mode & 0o777;
const hasBody = req => Number(req?.headers?.['content-length'] || 0) > 0 || Boolean(req?.headers?.['transfer-encoding']);

export function createListener({ socketPath, handler, httpModule = http, fsModule = fs, netModule = net, uid = process.getuid?.(), timers = globalThis, onRestart = () => undefined, beforeRebind = async () => undefined } = {}) {
  if (typeof socketPath !== 'string' || !socketPath || Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES) throw unavailable('path_too_long');
  if (!path.isAbsolute(socketPath) || !/^[A-Za-z0-9_./ -]+$/.test(socketPath) || socketPath.includes('//') || socketPath.split('/').some(part => part === '.' || part === '..')) throw unavailable('bad_path');
  if (typeof handler !== 'function') throw new TypeError('listener handler is required');
  const directory = path.dirname(socketPath);
  let server = null;
  let accepting = false;
  let ownsSocket = false;
  let stopping = false;
  let inFlight = 0;
  let binding = null;
  let restartTimer = null;
  let restartAttempt = 0;
  let recovering = false;
  let generation = 0;
  let terminalNotified = false;
  let lastRestartError = null;
  const drainWaiters = new Set();
  const notifyRestart = notice => { try { onRestart(notice); } catch { /* status hooks cannot crash the listener */ } };

  const settleDrain = () => { if (inFlight === 0) { for (const resolve of drainWaiters) resolve(); drainWaiters.clear(); } };
  const releasePrepared = req => {
    const prepared = req?.__icHandoffPrepared;
    if (!prepared) return;
    for (const release of [prepared.releaseBody, prepared.releaseSource, prepared.releaseGet, prepared.releaseAuth]) {
      try { release?.(); } catch { /* all holders must still be attempted */ }
    }
    delete req.__icHandoffPrepared;
  };
  const sendQuiesced = (req, res) => {
    releasePrepared(req);
    res.setHeader?.('Connection', 'close');
    res.writeHead?.(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Retry-After': '5', Connection: 'close', 'Content-Length': String(Buffer.byteLength(fixedUnavailable)) });
    res.end?.(fixedUnavailable);
    if (hasBody(req) && req.readableEnded !== true) res.once?.('finish', () => req.destroy?.());
  };
  const sendServerError = (req, res) => {
    try { releasePrepared(req); } catch { /* response below remains best effort */ }
    try {
      res.setHeader?.('Connection', 'close');
      res.writeHead?.(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close', 'Content-Length': String(Buffer.byteLength(fixedServerError)) });
      res.end?.(fixedServerError);
      if (hasBody(req) && req.readableEnded !== true) res.once?.('finish', () => req.destroy?.());
    } catch { try { res.destroy?.(); } catch { /* no safe fallback remains */ } }
  };
  const invoke = async (req, res) => {
    let counted = false;
    try {
      if (!accepting) return sendQuiesced(req, res);
      inFlight++;
      counted = true;
      return await handler(req, res);
    } catch { sendServerError(req, res); return undefined; }
    finally { if (counted) { inFlight--; settleDrain(); } }
  };
  const verifyDirectory = () => {
    let stat;
    try { stat = fsModule.lstatSync ? fsModule.lstatSync(directory) : fsModule.statSync(directory); }
    catch (error) {
      // Test ports need not model directory entries.  In production lstat
      // succeeds; the fallback still verifies mode/owner via stat.
      if (error?.code !== 'ENOENT' || typeof fsModule.statSync !== 'function') throw unavailable('permission');
      try { stat = fsModule.statSync(directory); } catch { throw unavailable('permission'); }
    }
    if (!stat.isDirectory?.() || stat.isSymbolicLink?.() || mode(stat) !== DIRECTORY_MODE || (uid !== undefined && stat.uid !== uid)) throw unavailable('permission');
  };
  const inspectSocket = async () => {
    let stat;
    try { stat = fsModule.lstatSync(socketPath); } catch (error) { if (error?.code === 'ENOENT') return; throw unavailable('permission'); }
    if (!stat.isSocket?.() || stat.isSymbolicLink?.() || mode(stat) !== SOCKET_MODE || (uid !== undefined && stat.uid !== uid)) throw unavailable('permission');
    const result = await new Promise(resolve => {
      let done = false;
      let timer = null;
      let client = null;
      const finish = value => {
        if (done) return;
        done = true;
        try { if (timer !== null) timers.clearTimeout?.(timer); } catch { /* inspection still settles */ }
        resolve(value);
      };
      try {
        timer = timers.setTimeout?.(() => { client?.destroy?.(); finish('other'); }, 1_000);
        timer?.unref?.();
      } catch { finish('other'); }
      if (done && timer !== null) { try { timers.clearTimeout?.(timer); } catch { /* already settled */ } }
      // A deterministic timer may fire synchronously.  Do not create a new
      // client after that timeout has already settled the inspection.
      if (done) return;
      try {
        const connect = netModule.createConnection || netModule.connect;
        if (typeof connect !== 'function') return finish('other');
        client = connect.call(netModule, { path: socketPath });
        client.once?.('connect', () => { client.destroy?.(); finish('live'); });
        client.once?.('error', error => finish(error?.code === 'ECONNREFUSED' ? 'stale' : 'other'));
      } catch { finish('other'); }
    });
    if (result === 'live') throw unavailable('in_use');
    if (result !== 'stale') throw unavailable('permission');
    try { fsModule.unlinkSync(socketPath); } catch (error) { if (error?.code !== 'ENOENT') throw unavailable('permission'); }
  };
  const unlinkOwned = () => {
    if (!ownsSocket) return;
    try {
      const stat = fsModule.lstatSync(socketPath);
      if (!stat.isSocket?.() || stat.isSymbolicLink?.() || (uid !== undefined && stat.uid !== uid)) throw unavailable('permission');
      fsModule.unlinkSync(socketPath);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    finally { ownsSocket = false; }
  };
  const scheduleRestart = error => {
    if (stopping || restartTimer !== null) return;
    if (restartAttempt >= RESTART_DELAYS.length) {
      if (!terminalNotified) {
        terminalNotified = true;
        notifyRestart({ ok: false, terminal: true, code: error?.code || lastRestartError?.code || 'socket_unavailable' });
      }
      return;
    }
    accepting = false;
    const delay = RESTART_DELAYS[restartAttempt++];
    let fired = false;
    const restart = () => {
      fired = true;
      restartTimer = null;
      Promise.resolve(beforeRebind()).catch(() => undefined).then(() => bind(generation)).then(result => {
        if (!result) return;
        terminalNotified = false; notifyRestart({ ok: true });
      }, bindError => { lastRestartError = bindError; notifyRestart({ ok: false, code: bindError?.code }); scheduleRestart(bindError); });
    };
    try {
      const timer = timers.setTimeout?.(restart, delay);
      if (!fired) { restartTimer = timer ?? null; timer?.unref?.(); }
      else if (timer !== undefined && timer !== null) timers.clearTimeout?.(timer);
    } catch (timerError) {
      lastRestartError = timerError;
      restartTimer = null;
      restartAttempt = RESTART_DELAYS.length;
      if (!terminalNotified) { terminalNotified = true; notifyRestart({ ok: false, terminal: true, code: 'socket_unavailable' }); }
    }
  };
  const recover = instance => {
    if (stopping || recovering || instance !== server) return;
    recovering = true;
    accepting = false;
    Promise.resolve().then(async () => {
      try {
        const closed = new Promise(resolve => { try { instance.close?.(resolve); } catch { resolve(); } });
        instance.closeIdleConnections?.();
        instance.closeAllConnections?.();
        await closed;
        if (server === instance) server = null;
        unlinkOwned();
      } catch {
        // Do not convert an ownership failure into an unlink of a path we no
        // longer control. The next bind will report its own safe diagnosis.
      } finally {
        recovering = false;
        scheduleRestart();
      }
    });
  };
  const attach = instance => {
    let ready = false;
    instance.on?.('checkContinue', async (req, res) => {
      try {
        if (!accepting) return sendQuiesced(req, res);
        const allowed = typeof handler.preflight === 'function' && await handler.preflight(req, res);
        if (allowed) { res.writeContinue?.(); await invoke(req, res); }
      } catch {
        releasePrepared(req);
        if (!res.headersSent) sendServerError(req, res);
      }
    });
    instance.on?.('clientError', (error, socket) => {
      const message = error?.code === 'HPE_HEADER_OVERFLOW'
        ? 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 0\r\n\r\n'
        : 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 0\r\n\r\n';
      socket.end?.(message, () => socket.destroy?.());
    });
    instance.on?.('upgrade', (_req, socket) => socket.destroy?.());
    instance.on?.('connect', (_req, socket) => socket.destroy?.());
    // This is deliberately persistent. A one-shot listen error handler leaves
    // an asynchronous Unix-socket error able to crash Electron later.
    instance.on?.('error', () => { if (ready) recover(instance); });
    instance.on?.('close', () => { if (ready && !recovering) recover(instance); });
    return () => { ready = true; };
  };
  const cleanupCreatedSocket = instance => {
    try { instance.close?.(() => undefined); } catch { /* best effort */ }
    try {
      const stat = fsModule.lstatSync(socketPath);
      if (stat.isSocket?.() && !stat.isSymbolicLink?.() && (uid === undefined || stat.uid === uid)) fsModule.unlinkSync(socketPath);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    ownsSocket = false;
  };
  const bind = (ticket = generation) => {
    if (binding) return binding;
    binding = (async () => {
      accepting = false;
      verifyDirectory();
      await inspectSocket();
      const instance = httpModule.createServer({ maxHeaderSize: 16 * 1024 }, invoke);
      server = instance;
      instance.maxConnections = 256;
      instance.keepAliveTimeout = 65_000;
      instance.headersTimeout = 70_000;
      instance.requestTimeout = 120_000;
      const activateRecovery = attach(instance);
      const normalizeListenError = error => error?.code === 'socket_unavailable' ? error : error?.code === 'EADDRINUSE' ? unavailable('in_use') : error?.code === 'EACCES' ? unavailable('permission') : error;
      try {
        await new Promise((resolve, reject) => {
          const onError = error => { instance.off?.('error', onError); reject(normalizeListenError(error)); };
          instance.once?.('error', onError);
          try { instance.listen({ path: socketPath }, () => { instance.off?.('error', onError); resolve(); }); } catch (error) { instance.off?.('error', onError); reject(normalizeListenError(error)); }
        });
      } catch (error) {
        // A synchronous listen throw and an asynchronous listen error both
        // leave no claim on the path. Close only this server; never unlink a
        // potentially foreign EADDRINUSE socket.
        try { instance.close?.(() => undefined); } catch { /* best effort */ }
        if (server === instance) server = null;
        throw normalizeListenError(error);
      }
      activateRecovery();
      try {
        fsModule.chmodSync(socketPath, SOCKET_MODE);
        const stat = fsModule.lstatSync(socketPath);
        if (!stat.isSocket?.() || stat.isSymbolicLink?.() || mode(stat) !== SOCKET_MODE || (uid !== undefined && stat.uid !== uid)) throw unavailable('permission');
      } catch (error) {
        try { cleanupCreatedSocket(instance); } catch { /* preserve the fixed permission diagnosis */ }
        if (server === instance) server = null;
        throw error?.code === 'socket_unavailable' ? error : unavailable('permission');
      }
      if (stopping || ticket !== generation) {
        cleanupCreatedSocket(instance);
        if (server === instance) server = null;
        return null;
      }
      ownsSocket = true;
      accepting = true;
      return { path: socketPath };
    })();
    return binding.finally(() => { binding = null; });
  };
  const quiesce = () => {
    accepting = false;
    return true;
  };
  const drain = async ({ drainMs = DEFAULT_DRAIN_MS } = {}) => {
    if (inFlight === 0) return true;
    let resolveDrain;
    const drained = new Promise(resolve => { resolveDrain = resolve; drainWaiters.add(resolve); });
    let timeoutTimer;
    const timeout = new Promise(resolve => {
      try { timeoutTimer = timers.setTimeout?.(resolve, drainMs); timeoutTimer?.unref?.(); } catch { resolve(); }
    });
    await Promise.race([drained, timeout]);
    if (timeoutTimer !== undefined) try { timers.clearTimeout?.(timeoutTimer); } catch { /* already settled */ }
    drainWaiters.delete(resolveDrain);
    return inFlight === 0;
  };
  const selfProbe = async ({ hostname } = {}) => {
    if (!server || !accepting || typeof hostname !== 'string' || !hostname) return { ok: false, code: 'socket_unavailable' };
    return new Promise(resolve => {
      let settled = false; let timer; let request; let response;
      const done = value => {
        if (settled) return;
        settled = true;
        try { if (timer !== undefined) timers.clearTimeout?.(timer); } catch { /* no work remains */ }
        resolve(value);
      };
      const abort = () => {
        try { response?.destroy?.(); } catch { /* request teardown is best effort */ }
        try { request?.destroy?.(); } catch { try { request?.abort?.(); } catch { /* no teardown port remains */ } }
      };
      const fail = () => { if (!settled) { abort(); done({ ok: false, code: 'socket_unavailable' }); } };
      const expectedResource = `https://${hostname}/mcp`;
      try {
        request = httpModule.request?.({ socketPath, path: '/.well-known/oauth-protected-resource/mcp', method: 'GET', headers: { host: hostname, accept: 'application/json' } }, incoming => {
          response = incoming;
          if (response?.statusCode !== 200 || typeof response?.on !== 'function') return fail();
          const declaredLength = response.headers?.['content-length'];
          if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > SELF_PROBE_MAX_BYTES)) return fail();
          const chunks = []; let bytes = 0;
          response.on('data', chunk => {
            try {
              const size = Buffer.isBuffer(chunk) ? chunk.length : typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk instanceof Uint8Array ? chunk.byteLength : NaN;
              if (!Number.isSafeInteger(size) || bytes + size > SELF_PROBE_MAX_BYTES) return fail();
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              bytes += size;
            } catch { fail(); }
          });
          response.on('error', fail);
          response.on('aborted', fail);
          response.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
              if (!body || typeof body !== 'object' || Array.isArray(body) || body.resource !== expectedResource) return fail();
              done({ ok: true });
            } catch { fail(); }
          });
        });
        if (settled) { abort(); return; }
        if (!request || typeof request.on !== 'function' || typeof request.end !== 'function') return fail();
        request.on('error', fail);
        request.setTimeout?.(SELF_PROBE_TIMEOUT_MS, fail);
        timer = timers.setTimeout?.(fail, SELF_PROBE_TIMEOUT_MS);
        if (timer === undefined) return fail();
        timer?.unref?.();
        request.end();
      } catch { fail(); }
    });
  };
  return Object.freeze({
    start: async () => {
      if (binding) return binding;
      stopping = false;
      terminalNotified = false;
      if (restartTimer !== null) {
        try { timers.clearTimeout?.(restartTimer); } catch { /* a bad timer port cannot block a manual start */ }
        restartTimer = null;
      }
      restartAttempt = 0;
      if (server && accepting) return { path: socketPath };
      generation++;
      return bind(generation);
    },
    get accepting() { return accepting; },
    get inFlight() { return inFlight; },
    quiesce,
    drain,
    selfProbe,
    async stop({ drainMs = DEFAULT_DRAIN_MS } = {}) {
      stopping = true;
      quiesce();
      generation++;
      if (restartTimer !== null) {
        try { timers.clearTimeout?.(restartTimer); } catch { /* stop must continue */ }
        restartTimer = null;
      }
      const instance = server;
      try { if (instance) {
        await drain({ drainMs });
        const closed = new Promise(resolve => { try { instance.close?.(resolve); } catch { resolve(); } });
        instance.closeIdleConnections?.();
        instance.closeAllConnections?.();
        await closed;
      }
      if (server === instance) server = null;
      unlinkOwned();
      } catch { try { if (server === instance) server = null; unlinkOwned(); } catch { /* stop never rejects */ } }
    },
  });
}
