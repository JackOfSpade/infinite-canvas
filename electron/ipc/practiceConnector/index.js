/**
 * The practice-interview connector.
 *
 * Practice interviews are a claude.ai voice chat whose feedback returns through
 * a custom connector at https://<hostname>/practice/mcp.  This module serves
 * that one endpoint on a local unix socket and keeps a Cloudflare tunnel
 * pointed at it.  It needs no OAuth.
 *
 * It reuses the setup the app already has on disk, so nothing is set up again:
 *   <userData>/handoff-bridge/config.json        -> `hostname` (only that field)
 *   <userData>/handoff-bridge/tunnel/tunnel.json -> tunnel state (tunnel/files.js)
 * Missing or unreadable setup leaves the connector off; it never throws.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONSTANTS } from './constants.js';
import { createListener as createRealListener } from './listener.js';
import { createPracticeMcpHandler, createPracticeRequestHandler, isPracticeRequest, PRACTICE_MCP_PATH } from './practiceMcp.js';
import { createRealTunnelSupervisor } from './tunnel/index.js';
import { readTunnelState as readRealTunnelState, tunnelPaths } from './tunnel/files.js';
import { reapOrphans as reapRealOrphans } from './tunnel/reap.js';
import { classifyProbe } from './tunnel/classify.js';

export { PRACTICE_MCP_PATH };

const PROBE_TIMEOUT_MS = 8_000;
const noop = () => undefined;

/** Reads only the `hostname` field of config.json; null when absent or unusable. */
export function readPracticeHostname(userData, { fsImpl = fs } = {}) {
  try {
    if (typeof userData !== 'string' || !userData) return null;
    const raw = fsImpl.readFileSync(path.join(userData, 'handoff-bridge', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const hostname = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.hostname : null;
    // Only a plain host name is accepted; the tunnel validates it strictly
    // before anything is exposed, and a failure there shows up as 'failed'.
    return typeof hostname === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(hostname.trim()) ? hostname.trim().toLowerCase() : null;
  } catch { return null; }
}

/**
 * The tunnel health check: GET on the practice path is answered 405 by the
 * practice handler itself, which proves the public hostname reaches this
 * connector (a 404 would mean the tunnel ingress is wrong).
 */
export function createPracticePublicProbe({ fetchImpl = globalThis.fetch, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  return async hostname => {
    if (typeof fetchImpl !== 'function') return { ok: false, code: 'edge-unreachable' };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeoutImpl(() => controller?.abort(), PROBE_TIMEOUT_MS);
    timer?.unref?.();
    try {
      const response = await fetchImpl(`https://${hostname}${PRACTICE_MCP_PATH}`, { method: 'GET', redirect: 'manual', signal: controller?.signal });
      if (response?.status === 405) return { ok: true };
      const code = classifyProbe({ status: response?.status, server: response?.headers?.get?.('server') || '' });
      return { ok: false, code: code === 'ok' ? 'wrong-origin' : code };
    } catch (error) {
      return { ok: false, code: error?.cause?.code === 'ENOTFOUND' ? 'dns-not-found' : 'edge-unreachable' };
    } finally { clearTimeoutImpl(timer); }
  };
}

let current = null; // { hostname, listener, supervisor, failed, token }
let generation = 0;
let starting = null;

const send404 = res => {
  const body = '{"error":"not_found"}';
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};

/** A listener handler that serves practice requests and 404s everything else. */
export function createPracticeRouter(practiceHandler) {
  const routed = async (req, res) => {
    if (isPracticeRequest(req) && await practiceHandler(req, res)) return undefined;
    send404(res);
    return undefined;
  };
  Object.defineProperty(routed, 'preflight', {
    value: (req, res) => {
      if (isPracticeRequest(req)) return typeof practiceHandler.preflight === 'function' ? practiceHandler.preflight(req, res) : false;
      send404(res);
      return false;
    },
    enumerable: false,
  });
  return routed;
}

function servingOf(state) {
  if (!state) return 'off';
  if (state.failed) return 'failed';
  let tunnel = null;
  try { tunnel = state.supervisor?.status?.() ?? null; } catch { return 'failed'; }
  if (!tunnel || typeof tunnel.state !== 'string') return state.ready ? 'live' : 'starting';
  switch (tunnel.state) {
    case 'online': return 'live';
    case 'failed': case 'degraded': return 'failed';
    case 'off': case 'paused': case 'stopping': return state.ready ? 'off' : 'starting';
    default: return 'starting';
  }
}

export function getPracticeConnectorStatus() {
  return { hostname: current?.hostname ?? null, serving: servingOf(current) };
}

async function shutdown(state) {
  if (!state) return;
  try { await (state.supervisor?.dispose || state.supervisor?.stop)?.call(state.supervisor); } catch { /* keep shutting down */ }
  try { await state.listener?.stop?.(); } catch { /* keep shutting down */ }
}

async function launch(options, token) {
  const {
    userData, fsImpl = fs, readTunnelState = readRealTunnelState, reapOrphans = reapRealOrphans,
    createListener = createRealListener, createTunnelSupervisor = createRealTunnelSupervisor,
    practiceHandler = null, mcp = null, now = Date.now, timers = globalThis,
    publicProbeFn = null, fetchImpl, powerMonitor, HOME = os.homedir(), TMPDIR = os.tmpdir(),
  } = options;
  if (typeof userData !== 'string' || !userData) return;
  const hostname = readPracticeHostname(userData, { fsImpl });
  let tunnelState = null;
  try { tunnelState = readTunnelState(userData); } catch { tunnelState = null; }
  if (!hostname || !tunnelState || typeof tunnelState !== 'object') return;

  const state = { hostname, listener: null, supervisor: null, failed: false, ready: false, token };
  current = state;
  try {
    const paths = tunnelPaths(userData);
    // Reap a tunnel left behind by a previous run of this app, for the same config.
    try { await reapOrphans({ userData, configPath: paths.config }); } catch { /* best effort */ }
    if (token !== generation) return;
    const socketPath = path.join(userData, CONSTANTS.SOCKET_RELATIVE_PATH);
    const handler = practiceHandler || createPracticeRequestHandler({ hostname, mcp: mcp || createPracticeMcpHandler(), now, setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout });
    state.listener = createListener({ socketPath, handler: createPracticeRouter(handler), fsModule: fsImpl === fs ? undefined : fsImpl, timers, beforeRebind: async () => { await state.supervisor?.stop?.(); } });
    state.supervisor = createTunnelSupervisor({
      userData, hostname, socketPath,
      credentialsPath: tunnelState.credentialsPath, binaryPath: tunnelState.binaryPath, pin: tunnelState.pin, approvedAt: tunnelState.approvedAt,
      publicProbeFn: publicProbeFn || createPracticePublicProbe({ fetchImpl }),
      timers, now, fsImpl, powerMonitor, HOME, TMPDIR,
    });
    await state.listener.start();
    if (token !== generation) return;
    const started = await state.supervisor.start();
    if (token !== generation) return;
    if (started?.ok === false) state.failed = true;
    state.ready = true;
  } catch {
    if (token === generation) state.failed = true;
  }
}

/**
 * Starts the listener and the tunnel supervisor from the existing setup.
 * Resolves to the resulting status; never rejects.
 */
export async function startPracticeConnector(options = {}) {
  try {
    if (current || starting) { await starting; return getPracticeConnectorStatus(); }
    const token = ++generation;
    starting = launch(options || {}, token).catch(noop).finally(() => { starting = null; });
    await starting;
    if (token !== generation) await shutdown(current && current.token === token ? current : null);
  } catch { /* status below reports what is true */ }
  return getPracticeConnectorStatus();
}

/** Closes the tunnel, then the listener. Safe to call at any time. */
export async function stopPracticeConnector() {
  generation++;
  const state = current;
  current = null;
  try { await starting; } catch { /* launch never rejects */ }
  if (current && current !== state) { const late = current; current = null; await shutdown(late); }
  await shutdown(state);
  return { hostname: null, serving: 'off' };
}
