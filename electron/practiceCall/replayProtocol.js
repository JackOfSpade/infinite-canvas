import { createReadStream as nodeCreateReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';

const SCHEME = 'practice-call:';
const AUDIO_NAME = 'call.m4a';

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function parseRange(header, size) {
  if (typeof header !== 'string' || !header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { invalid: true };
  let start;
  let end;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return { invalid: true };
    if (start >= size) return { invalid: true };
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/**
 * Privileged `practice-call://<callId>/call.m4a` handler. Only call ids that
 * exist in the store are readable; traversal, symlinks and unknown ids are 404.
 */
export function createReplayHandler({ store, createReadStream = nodeCreateReadStream } = {}) {
  if (!store || typeof store.hasCall !== 'function' || typeof store.audioPath !== 'function') throw new TypeError('Replay protocol requires a call store.');
  return async function handler(request) {
    if (!request || typeof request.url !== 'string') return notFound();
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.protocol !== SCHEME || url.username || url.password) return notFound();
    if (url.pathname !== `/${AUDIO_NAME}` || url.search) return notFound();
    const callId = url.hostname;
    if (!callId) return notFound();
    let known = false;
    try {
      known = await store.hasCall(callId);
    } catch {
      return notFound();
    }
    if (!known) return notFound();
    const file = await store.audioPath(callId);
    if (!file) return notFound();
    let entry;
    try {
      entry = await lstat(file);
    } catch {
      return notFound();
    }
    if (!entry.isFile() || entry.isSymbolicLink()) return notFound();
    const headers = { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'content-length': String(entry.size) } });
    if (request.method && request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    // A zero-byte recording is a valid, empty body: a read stream with end -1 throws.
    if (entry.size === 0) return new Response(null, { status: 200, headers: { ...headers, 'content-length': '0' } });
    const range = parseRange(request.headers?.get?.('range'), entry.size);
    if (range?.invalid) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${entry.size}` } });
    const start = range ? range.start : 0;
    const end = range ? range.end : entry.size - 1;
    const length = entry.size === 0 ? 0 : end - start + 1;
    const stream = createReadStream(file, { start, end });
    const body = Readable.toWeb(stream);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { ...headers, 'content-length': String(length), ...(range ? { 'content-range': `bytes ${start}-${end}/${entry.size}` } : {}) },
    });
  };
}

export function createReplayProtocol(deps) {
  return Object.freeze({ handler: createReplayHandler(deps) });
}

export default createReplayProtocol;
