import { TUNNEL_CONSTANTS } from './constants.js';
import { classifyProbe } from './classify.js';

export function chooseMetricsPort({ random = Math.random, attempted = new Set() } = {}) {
  const span = TUNNEL_CONSTANTS.METRICS_PORT_MAX - TUNNEL_CONSTANTS.METRICS_PORT_MIN + 1;
  const draw = Number(random());
  if (!Number.isFinite(draw)) return null;
  const first = Math.max(0, Math.min(span - 1, Math.floor(draw * span)));
  for (let index = 0; index < span; index++) {
    const port = TUNNEL_CONSTANTS.METRICS_PORT_MIN + ((first + index) % span);
    if (!attempted.has(port)) return port;
  }
  return null;
}

async function bounded(request, url, { timeoutMs = 8_000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let timer = null; const controller = typeof AbortController === 'function' ? new AbortController() : null;
  try { return await Promise.race([Promise.resolve(request(url, controller ? { signal: controller.signal } : undefined)), new Promise((_, reject) => { timer = setTimeoutImpl(() => { controller?.abort(); reject(new Error('timeout')); }, timeoutMs); timer?.unref?.(); })]); } finally { if (timer !== null) clearTimeoutImpl(timer); }
}

export async function probeReady(metricsPort, { fetchImpl = null, ...options } = {}) {
  if (!Number.isInteger(metricsPort) || metricsPort < TUNNEL_CONSTANTS.METRICS_PORT_MIN || metricsPort > TUNNEL_CONSTANTS.METRICS_PORT_MAX) return { ok: false, state: 'unavailable' };
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== 'function') return { ok: false, state: 'unavailable' };
  try { const response = await bounded(request, `http://127.0.0.1:${metricsPort}/ready`, options); return { ok: response.status === 200, state: response.status === 200 ? 'ready' : 'waiting' }; } catch { return { ok: false, state: 'waiting' }; }
}

export async function publicProbe(hostname, { publicProbe: request, ...options } = {}) {
  if (typeof request !== 'function') return { ok: false, code: 'edge-unreachable' };
  const url = `https://${hostname}/.well-known/oauth-protected-resource/mcp`;
  try { const response = await bounded((target, signal) => request(target, { redirect: 'manual', maxBodyBytes: 16 * 1024, ...signal }), url, options); const expected = `https://${hostname}/mcp`; const code = response?.status === 200 && response?.body?.resource !== expected ? 'wrong-origin' : classifyProbe(response); return { ok: code === 'ok', code }; } catch { return { ok: false, code: 'edge-unreachable' }; }
}
