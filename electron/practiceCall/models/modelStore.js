// Model store: pinned downloads into <userData>/practice-models/.
// Downloads go to a temp file, are verified (sha256, plus zip md5 for tone),
// extracted when needed, and only then renamed to the final name, so a partial
// file never appears under the final name.

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const SMART_TURN_URL =
  'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-gpu.onnx';
export const TONE_URL =
  'https://zenodo.org/api/records/6221127/files/w2v2-L-robust-12.6bc4a7fd-1.1.0.zip/content';

export const MODEL_SPECS = Object.freeze({
  smartTurn: Object.freeze({
    name: 'smartTurn',
    fileName: 'smart-turn-v3.2-gpu.onnx',
    url: SMART_TURN_URL,
    bytes: 32411198,
    sha256: 'ab8dc64b88713f90b571c15b714bd1330e6c883cad8763dacf65c9376dc539be',
  }),
  tone: Object.freeze({
    name: 'tone',
    fileName: 'tone.onnx',
    url: TONE_URL,
    bytes: 609889780,
    modelBytes: 661423381,
    sha256: '9b6e449686c0db86f5c607b8c9fa1d87468c27198a1f0a20280c4e258239763d',
    // The zip's md5, also exposed as the archive check below.
    md5: '76fef8c090addd7fcee60c64e9536ced',
    archive: Object.freeze({
      md5: '76fef8c090addd7fcee60c64e9536ced',
      extension: '.zip',
      entry: 'model.onnx',
    }),
  }),
});

export function defaultUnzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zipPath, destDir], (error, stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const detail = String(stderr || error.message || '').trim();
      reject(new Error(`unzip failed for ${path.basename(zipPath)}: ${detail}`));
    });
  });
}

export async function hashFile(filePath, algorithm, { createReadStream = fsSync.createReadStream } = {}) {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

function resolveFs(injected) {
  const base = injected || fsp;
  const promises = base.promises ? base.promises : base;
  const sync = typeof base.existsSync === 'function' ? base : fsSync;
  return { promises, sync };
}

function abortError() {
  const error = new Error('model download aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function randomTag() {
  return randomBytes(6).toString('hex');
}

async function closeQuietly(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // already closed
  }
}

export function createModelStore({
  rootDir, fetch: fetchImpl, fs: fsInjected, unzip, specs = MODEL_SPECS,
} = {}) {
  if (!rootDir) throw new Error('createModelStore requires rootDir');
  const io = resolveFs(fsInjected);
  const doFetch = fetchImpl || globalThis.fetch;
  const doUnzip = unzip || defaultUnzip;
  const inFlight = new Map();
  const downloading = new Set();

  const specOf = (name) => {
    const spec = specs[name];
    if (!spec) throw new Error(`unknown model: ${name}`);
    return spec;
  };
  const pathOf = (name) => path.join(rootDir, specOf(name).fileName);

  function isReady(name) {
    try {
      const info = io.sync.statSync(pathOf(name));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  function status() {
    const report = {};
    for (const name of Object.keys(specs)) {
      report[name] = downloading.has(name) ? 'downloading' : isReady(name) ? 'ready' : 'missing';
    }
    return report;
  }

  function readChunks(body, onChunk) {
    return (async () => {
      if (!body) return;
      if (typeof body.getReader === 'function') {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await onChunk(value);
        }
        return;
      }
      if (typeof body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body) await onChunk(chunk);
        return;
      }
      if (typeof body.arrayBuffer === 'function') {
        await onChunk(new Uint8Array(await body.arrayBuffer()));
      }
    })();
  }

  async function verify(filePath, spec, algorithm, expected) {
    const actual = await hashFile(filePath, algorithm);
    if (actual.toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error(
        `${spec.name} ${algorithm} mismatch: expected ${expected}, got ${actual}`,
      );
    }
  }

  async function download(spec, tempPath, { onProgress, signal, algorithm, expected }) {
    if (signal?.aborted) throw abortError();
    let handle = null;
    try {
      const response = await doFetch(spec.url, { signal });
      if (!response || (response.ok === false)) {
        throw new Error(`model download failed for ${spec.name}: HTTP ${response?.status}`);
      }
      const headerTotal = Number(response.headers?.get?.('content-length'));
      const totalBytes = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : spec.bytes;
      let receivedBytes = 0;
      onProgress?.({ name: spec.name, receivedBytes: 0, totalBytes });
      handle = await io.promises.open(tempPath, 'w');
      await readChunks(response.body, async (chunk) => {
        if (signal?.aborted) throw abortError();
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength ?? chunk.length);
        await handle.write(data);
        receivedBytes += data.length;
        onProgress?.({ name: spec.name, receivedBytes, totalBytes });
      });
      await closeQuietly(handle);
      handle = null;
      if (signal?.aborted) throw abortError();
      await verify(tempPath, spec, algorithm, expected);
      return totalBytes;
    } catch (error) {
      await closeQuietly(handle);
      await io.promises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function ensureOne(spec, { onProgress, signal } = {}) {
    await io.promises.mkdir(rootDir, { recursive: true, mode: 0o700 });
    if (signal?.aborted) throw abortError();
    const finalPath = path.join(rootDir, spec.fileName);
    if (isReady(spec.name)) return finalPath;
    const tag = randomTag();
    const tempPath = path.join(rootDir, `.${spec.name}-${tag}.part`);
    if (!spec.archive) {
      await download(spec, tempPath, {
        onProgress, signal, algorithm: 'sha256', expected: spec.sha256,
      });
      if (signal?.aborted) throw abortError();
      await io.promises.rename(tempPath, finalPath);
      return finalPath;
    }
    const zipPath = path.join(rootDir, `.${spec.name}-${tag}${spec.archive.extension}`);
    const extractDir = path.join(rootDir, `.${spec.name}-${tag}-extract`);
    try {
      await download(spec, zipPath, {
        onProgress, signal, algorithm: 'md5', expected: spec.archive.md5,
      });
      if (signal?.aborted) throw abortError();
      await io.promises.mkdir(extractDir, { recursive: true, mode: 0o700 });
      await doUnzip(zipPath, extractDir);
      if (signal?.aborted) throw abortError();
      const memberPath = path.join(extractDir, spec.archive.entry);
      await verify(memberPath, spec, 'sha256', spec.sha256);
      await io.promises.rename(memberPath, finalPath);
      return finalPath;
    } finally {
      await io.promises.rm(zipPath, { force: true }).catch(() => {});
      await io.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function ensure(name, options = {}) {
    const spec = specOf(name);
    const existing = inFlight.get(name);
    if (existing) return existing;
    if (isReady(name)) return Promise.resolve(path.join(rootDir, spec.fileName));
    downloading.add(name);
    const task = ensureOne(spec, options).finally(() => {
      downloading.delete(name);
      inFlight.delete(name);
    });
    inFlight.set(name, task);
    return task;
  }

  return { status, pathOf, ensure };
}
