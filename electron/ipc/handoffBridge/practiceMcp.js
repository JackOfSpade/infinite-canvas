/**
 * The practice-interview connector: a small MCP endpoint at /practice/mcp on
 * the handoff bridge's public hostname, added to claude.ai as a custom
 * connector without OAuth.
 *
 * It is deliberately separate from /mcp. The OAuth bridge is pinned to the
 * ChatGPT client (CIMD client id, signed token requests, OpenAI egress
 * ranges), and a Claude chat cannot satisfy any of that. This endpoint
 * exposes nothing to read: its only effect is to store feedback for a
 * session the app armed moments ago, and the one-shot session code inside
 * the pasted starter is the capability. Everything else is bounded: body
 * size, per-source rate, in-flight count, read timeout.
 */
import { INTERVIEW_PRACTICE_FEEDBACK_SCHEMA, PRACTICE_CHECK_TOOL, PRACTICE_FINISH_TOOL } from '../interviewQaPractice.js';
import { checkInterviewPractice, finishInterviewPractice } from '../interviewPracticeRegistry.js';
import { sourceKey } from './http.js';

export const PRACTICE_MCP_PATH = '/practice/mcp';
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ARG_MAX = 64;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const validId = value => value === undefined || value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

export const PRACTICE_TOOLS = Object.freeze([
  Object.freeze({
    name: PRACTICE_CHECK_TOOL, title: 'Check the practice interview session',
    description: 'Confirms that the session code from the practice starter is armed in Infinite Canvas. Read-only; call it once at the start if you want to make sure feedback can be delivered.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['session'], properties: { session: { type: 'string', description: 'The practice session code from the starter message.' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }),
  Object.freeze({
    name: PRACTICE_FINISH_TOOL, title: 'Send practice interview feedback',
    description: 'Sends the written feedback for a finished practice interview to Infinite Canvas, where the person reads it. Call it exactly once, after the call has been closed, with the session code from the starter. Base it on the entire session. The result has a status: accepted, rejected (fix what the note says and call again), duplicate, unknown_session, or expired.',
    inputSchema: INTERVIEW_PRACTICE_FEEDBACK_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }),
]);

export function createPracticeMcpHandler({ finish = finishInterviewPractice, check = checkInterviewPractice, version = '1' } = {}) {
  const toolResult = (id, value) => rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
  return async function handle(request) {
    if (!plain(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !validId(request.id)) return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
    const { id, method, params } = request;
    if (id === undefined || id === null) return { status: 202, body: null }; // notifications
    if (method === 'initialize') {
      const requested = plain(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return { status: 200, body: rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'infinite-canvas-practice', title: 'Infinite Canvas Practice', version },
        instructions: `This connector only receives the feedback of an Infinite Canvas practice interview. Call ${PRACTICE_FINISH_TOOL} once when the mock interview is over, with the session code from the person's starter message.`,
      }) };
    }
    if (method === 'ping') return { status: 200, body: rpcResult(id, {}) };
    if (method === 'tools/list') return { status: 200, body: rpcResult(id, { tools: PRACTICE_TOOLS.map(tool => ({ ...tool })) }) };
    if (method === 'tools/call') {
      if (!plain(params) || typeof params.name !== 'string' || !plain(params.arguments)) return { status: 200, body: rpcError(id, -32602, 'Invalid params') };
      const session = params.arguments.session;
      if (typeof session !== 'string' || !session.trim() || session.length > SESSION_ARG_MAX) return { status: 200, body: toolResult(id, { status: 'rejected', note: 'session must be the practice session code from the starter message.' }) };
      if (params.name === PRACTICE_CHECK_TOOL) return { status: 200, body: toolResult(id, await check(session.trim())) };
      if (params.name === PRACTICE_FINISH_TOOL) return { status: 200, body: toolResult(id, await finish(session.trim(), params.arguments)) };
      return { status: 200, body: rpcError(id, -32602, 'Unknown tool') };
    }
    return { status: 200, body: rpcError(id, -32601, 'Method not found') };
  };
}

// ------------------------------------------------------------------- HTTP --

const DEFAULTS = Object.freeze({ maxBodyBytes: 512 * 1024, readTimeoutMs: 15_000, perSourceCapacity: 30, perSourcePerSecond: 0.5, inflight: 4, maxBuckets: 1000 });
const hostOf = req => {
  const header = req.headers?.host;
  const value = Array.isArray(header) ? header[0] : header;
  return String(value || '').toLowerCase().replace(/:\d+$/u, '');
};
const send = (res, status, body, headers = {}) => {
  const encoded = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(encoded), 'Cache-Control': 'no-store', ...headers });
  res.end(encoded);
};
const ADMITTED = Symbol('practice-admitted');

export function isPracticeRequest(req) {
  try { return new URL(String(req?.url || ''), 'http://practice.invalid').pathname === PRACTICE_MCP_PATH; } catch { return false; }
}

/**
 * Returns true when it handled the request (a /practice/mcp target), false to
 * fall through to the OAuth bridge. `handle.preflight` runs the same header
 * gates for an `Expect: 100-continue` request before the listener writes
 * 100 Continue, so a refused request never gets a continue.
 */
export function createPracticeRequestHandler({ hostname = null, mcp = createPracticeMcpHandler(), now = Date.now, limits = {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, onEvent = () => {} } = {}) {
  const config = { ...DEFAULTS, ...limits };
  const buckets = new Map(); // source key (IPv4 exact, IPv6 /64) -> { tokens, at }
  let inflight = 0;
  const take = source => {
    const bucket = buckets.get(source) || { tokens: config.perSourceCapacity, at: now() };
    const elapsed = Math.max(0, now() - bucket.at) / 1000;
    bucket.tokens = Math.min(config.perSourceCapacity, bucket.tokens + elapsed * config.perSourcePerSecond);
    bucket.at = now();
    if (buckets.size >= config.maxBuckets) {
      // Evict only buckets that are full again or idle: churn from many
      // sources never hands a depleted source a fresh allowance.
      for (const [key, other] of buckets) if (key !== source && (other.tokens >= config.perSourceCapacity - 1 || now() - other.at > 60_000)) buckets.delete(key);
    }
    if (buckets.size < config.maxBuckets || buckets.has(source)) buckets.set(source, bucket);
    if (bucket.tokens < 1) return Math.ceil((1 - bucket.tokens) / config.perSourcePerSecond);
    bucket.tokens -= 1;
    return 0;
  };
  /** Header-only gates; sends the refusal itself and returns false. */
  const admit = (req, res) => {
    if (hostname && hostOf(req) !== hostname) { send(res, 421, { error: 'misdirected_request' }); return false; }
    if (req.method !== 'POST') { send(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' }); return false; }
    const wait = take(sourceKey(req));
    if (wait) { onEvent({ ev: 'practice_rate_limited' }); send(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(wait) }); return false; }
    if (!/^application\/json\b/iu.test(String(req.headers?.['content-type'] || ''))) { send(res, 415, { error: 'unsupported_media_type' }); return false; }
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) { send(res, 413, { error: 'payload_too_large' }); return false; }
    if (inflight >= config.inflight) { send(res, 503, { error: 'busy' }, { 'Retry-After': '2' }); return false; }
    inflight += 1;
    try { req[ADMITTED] = true; } catch { /* a frozen request object cannot carry the mark */ }
    return true;
  };
  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeoutImpl(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeoutImpl(() => { finish(Object.assign(new Error('timeout'), { status: 408 })); try { req.destroy(); } catch { /* already gone */ } }, config.readTimeoutMs);
    req.on('data', chunk => { size += chunk.length; if (size > config.maxBodyBytes) { finish(Object.assign(new Error('too large'), { status: 413 })); try { req.destroy(); } catch { /* already gone */ } return; } chunks.push(chunk); });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', error => finish(error));
  });
  async function handle(req, res) {
    if (!isPracticeRequest(req)) return false;
    if (req[ADMITTED]) { try { delete req[ADMITTED]; } catch { /* mark may be read-only */ } }
    else if (!admit(req, res)) return true;
    try {
      let bytes;
      try { bytes = await readBody(req); } catch (error) { if (!res.headersSent) send(res, error?.status === 413 ? 413 : error?.status === 408 ? 408 : 400, { error: error?.status === 413 ? 'payload_too_large' : 'bad_request' }); return true; }
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { send(res, 400, rpcError(null, -32700, 'Parse error')); return true; }
      if (Array.isArray(body)) { send(res, 400, rpcError(null, -32600, 'Batches are not supported')); return true; }
      const result = await mcp(body);
      onEvent({ ev: 'practice_request', method: typeof body?.method === 'string' ? body.method.slice(0, 40) : 'invalid', status: result.status });
      send(res, result.status, result.body);
    } catch { if (!res.headersSent) send(res, 500, rpcError(null, -32603, 'Internal error')); }
    finally { inflight -= 1; }
    return true;
  }
  /** For the listener's Expect handling: null when not a practice request. */
  handle.preflight = (req, res) => (isPracticeRequest(req) ? admit(req, res) : null);
  return handle;
}
