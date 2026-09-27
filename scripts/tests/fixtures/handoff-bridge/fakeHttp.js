import { Duplex } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';

class MemorySocket extends Duplex {
  constructor() {
    super();
    this.writes = [];
    this.destroyedByTest = false;
    this.remoteAddress = '127.0.0.1';
    this.remotePort = 43193;
  }
  _read() {}
  _write(chunk, _encoding, callback) { this.writes.push(Buffer.from(chunk)); callback(); }
  destroy(error) { this.destroyedByTest = true; return super.destroy(error); }
}

function parseResponse(raw) {
  const divider = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, divider < 0 ? raw.length : divider);
  const lines = head.split('\r\n');
  const status = Number((lines.shift() || '').split(' ')[1]) || 0;
  const headers = Object.create(null);
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status, headers, body: Buffer.from(divider < 0 ? '' : raw.slice(divider + 4)) };
}

export function parseContentLength(headers = {}) {
  const value = headers['content-length'] ?? headers['Content-Length'];
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeHandler(handler) {
  if (typeof handler === 'function') return { request: handler };
  if (handler && typeof handler === 'object') return handler;
  throw new TypeError('exchange handler must be a function or handler object');
}

// Creates real IncomingMessage/ServerResponse objects over an in-memory
// Duplex. No server, port, socket path, or network request is opened.
export async function exchange(handler, {
  method = 'POST', path = '/mcp', headers = {}, body = '', chunkSize = 0,
  chunked = false, expectContinue = false, connection = 'keep-alive', abort = false,
} = {}) {
  const handlers = normalizeHandler(handler);
  const socket = new MemorySocket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = path;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.complete = true;
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  req.headers = Object.fromEntries(Object.entries({ host: 'bridge.example.com', connection, ...headers })
    .map(([key, value]) => [key.toLowerCase(), String(value)]));
  if (expectContinue) req.headers.expect = '100-continue';
  if (chunked) {
    delete req.headers['content-length'];
    req.headers['transfer-encoding'] = 'chunked';
  } else if (!Object.hasOwn(req.headers, 'content-length')) {
    req.headers['content-length'] = String(bodyBuffer.length);
  }
  req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, value]);
  let readBytes = 0;
  const originalRead = req.read.bind(req);
  req.read = size => {
    const value = originalRead(size);
    if (value !== null) readBytes += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value));
    return value;
  };
  let bodyDestroyed = false;
  const originalDestroy = req.destroy.bind(req);
  req.destroy = error => { bodyDestroyed = true; return originalDestroy(error); };

  const response = new ServerResponse(req);
  response.assignSocket(socket);
  const done = new Promise((resolve, reject) => {
    response.once('finish', resolve);
    response.once('error', reject);
  });
  const selected = expectContinue && typeof handlers.checkContinue === 'function'
    ? handlers.checkContinue
    : handlers.request;
  if (typeof selected !== 'function') throw new TypeError('exchange has no selected request handler');
  const call = Promise.resolve().then(() => selected(req, response));

  if (abort) {
    req.destroy(new Error('synthetic request abort'));
  } else if (chunkSize > 0) {
    for (let offset = 0; offset < bodyBuffer.length; offset += chunkSize) req.push(bodyBuffer.subarray(offset, offset + chunkSize));
    req.push(null);
  } else {
    req.push(bodyBuffer);
    req.push(null);
  }
  await call;
  if (!response.writableEnded) await done;
  const raw = Buffer.concat(socket.writes);
  const parsed = parseResponse(raw.toString('utf8'));
  return {
    req,
    res: response,
    socket,
    raw,
    ...parsed,
    reads: readBytes,
    readBytes,
    contentLength: parseContentLength(req.headers),
    destroyed: socket.destroyedByTest,
    observations: Object.freeze({ expectContinue: expectContinue === true, connection: req.headers.connection, bodyDestroyed }),
  };
}

export const makeExchange = exchange;
