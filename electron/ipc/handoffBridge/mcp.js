import { CONSTANTS } from './constants.js';
import { TOOLS_LIST } from './tools.js';

const SUPPORTED_PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
const RETRYABLE = Object.freeze({ status: 'error_retryable', note: 'The app is still working on this call. Repeat the identical call.' });
const TOO_LARGE = Object.freeze({ status: 'too_large', note: 'The response is too large to send.' });
const INVALID_NOTES = Object.freeze({
  name: 'A supported tool name is required.',
  session: 'session must be a non-empty string within the allowed length.',
  handoffCode: 'handoffCode must be a non-empty string within the allowed length.',
  response: 'response must be a string, object, or array.',
});

const own = (value, key) => Object.hasOwn(value, key);
const plainObject = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });

function validId(value) {
  return value === undefined || value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function copyArguments(params, toolName) {
  if (!plainObject(params)) return { error: INVALID_NOTES.name };
  if (typeof params.name !== 'string' || params.name !== toolName) return { error: INVALID_NOTES.name };
  const raw = plainObject(params.arguments) ? params.arguments : null;
  if (!raw) return { error: toolName === 'get_handoff' ? INVALID_NOTES.session : INVALID_NOTES.handoffCode };
  const session = own(raw, 'session') ? raw.session : undefined;
  if (typeof session !== 'string' || session.length < 1 || session.length > CONSTANTS.SESSION_ARG_MAX_CHARS) return { error: INVALID_NOTES.session };
  if (toolName === 'get_handoff') return { value: { session } };
  const handoffCode = own(raw, 'handoffCode') ? raw.handoffCode : undefined;
  if (typeof handoffCode !== 'string' || handoffCode.length < 1 || handoffCode.length > CONSTANTS.HANDOFF_CODE_ARG_MAX_CHARS) return { error: INVALID_NOTES.handoffCode };
  const response = own(raw, 'response') ? raw.response : undefined;
  let copiedResponse;
  if (typeof response === 'string') copiedResponse = response;
  else if (Array.isArray(response) || plainObject(response)) {
    try { copiedResponse = JSON.stringify(response); } catch { return { error: INVALID_NOTES.response }; }
  } else return { error: INVALID_NOTES.response };
  if (typeof copiedResponse !== 'string') return { error: INVALID_NOTES.response };
  return { value: { session, handoffCode, response: copiedResponse } };
}

function toolResult(id, body) {
  let text;
  try { text = JSON.stringify(body); } catch { text = undefined; }
  if (typeof text !== 'string') text = JSON.stringify({ status: 'app_unavailable', note: 'The app result could not be sent.' });
  if (Buffer.byteLength(text, 'utf8') > CONSTANTS.MAX_TOOL_RESULT_BYTES) {
    text = JSON.stringify({ status: 'app_unavailable', note: 'The result was too large to send.' });
  }
  return rpcResult(id, { content: [{ type: 'text', text }] });
}

/**
 * Pure JSON-RPC dispatcher. HTTP owns parsing, authentication, headers and body
 * limits; this module owns only the authenticated MCP method surface.
 */
export function createMcpHandler({
  port,
  tools = TOOLS_LIST,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  deadlineMs = CONSTANTS.TOOL_CALL_DEADLINE_MS,
  emit = () => undefined,
} = {}) {
  if (!port || typeof port.get !== 'function' || typeof port.submit !== 'function') throw new TypeError('MCP engine port is required');
  let inFlight = 0;

  async function callPort(name, args, grant, signal) {
    if (inFlight >= CONSTANTS.TOOL_CALL_CAP) return RETRYABLE;
    inFlight++;
    let timer;
    try {
      const operation = Promise.resolve().then(() => name === 'get'
        ? port.get({ ...args, grant, signal })
        : port.submit({ ...args, grant, signal }));
      // A submit may commit after the client-facing deadline; never leave an
      // unhandled rejection behind when that happens.
      operation.catch(() => undefined);
      const deadline = new Promise(resolve => {
        timer = setTimeoutImpl(() => resolve({ timedOut: true }), deadlineMs);
        timer?.unref?.();
      });
      const outcome = await Promise.race([
        operation.then(value => ({ value }), () => ({ failed: true })),
        deadline,
      ]);
      return outcome.timedOut || outcome.failed ? RETRYABLE : outcome.value;
    } catch {
      // An injected timer-port failure is indistinguishable from an unavailable
      // app to the public protocol and must never reject out of this boundary.
      return RETRYABLE;
    } finally {
      // Timer ports are deliberately injectable for the fault sweep.  A bad
      // clear must never strand this handler at its concurrency limit.
      try { if (timer !== undefined) clearTimeoutImpl(timer); } catch { /* the in-flight release below is mandatory */ }
      finally { inFlight--; }
    }
  }

  const handler = async (request, { grant = undefined, signal = undefined } = {}) => {
    if (!plainObject(request) || Array.isArray(request)) return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !validId(request.id)) {
      return { status: 400, body: rpcError(validId(request.id) ? request.id : null, -32600, 'Invalid Request') };
    }
    const id = request.id;
    if (request.method === 'initialize') {
      const requested = plainObject(request.params) && typeof request.params.protocolVersion === 'string' ? request.params.protocolVersion : '';
      return { status: 200, body: rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : '2025-11-25',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'infinite-canvas', version: '1.0.0' },
      }) };
    }
    if (request.method.startsWith('notifications/')) return { status: 202, body: null };
    if (request.method === 'ping') return { status: 200, body: rpcResult(id, {}) };
    if (request.method === 'tools/list') return { status: 200, body: rpcResult(id, { tools }) };
    if (request.method !== 'tools/call') {
      if (request.method === 'server/discover') { try { emit('server_discover'); } catch { /* telemetry must not alter the wire response */ } }
      return { status: request.method === 'server/discover' ? 400 : 200, body: rpcError(id, -32601, 'Method not found') };
    }
    const params = plainObject(request.params) ? request.params : null;
    const toolName = params && own(params, 'name') ? params.name : undefined;
    if (toolName !== 'get_handoff' && toolName !== 'submit_handoff') return { status: 200, body: rpcError(id, -32602, 'Invalid params') };
    const copied = copyArguments(params, toolName);
    if (copied.error) return { status: 200, body: toolResult(id, { status: 'invalid_arguments', note: copied.error }) };
    if (toolName === 'submit_handoff' && Buffer.byteLength(copied.value.response, 'utf8') > CONSTANTS.MAX_RESPONSE_BYTES) {
      return { status: 200, body: toolResult(id, TOO_LARGE) };
    }
    const result = await callPort(toolName === 'get_handoff' ? 'get' : 'submit', copied.value, grant, signal);
    return { status: 200, body: toolResult(id, result) };
  };
  Object.defineProperty(handler, 'inFlight', { enumerable: true, get: () => inFlight });
  return handler;
}

export const MCP_PROTOCOL_VERSIONS = Object.freeze([...SUPPORTED_PROTOCOLS]);
