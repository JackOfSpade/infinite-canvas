import fsPromises from 'node:fs/promises';
import path from 'node:path';

const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const AUDIO_FILES = Object.freeze(['call.m4a', 'candidate.wav', 'interviewer.wav']);

function storeError(code, message) {
  const error = new Error(`Practice call store: ${message}`);
  error.code = code;
  return error;
}

function checkId(value) {
  if (typeof value !== 'string' || !CALL_ID_RE.test(value)) throw storeError('INVALID_CALL_ID', 'invalid call id');
  return value;
}

async function lstatOrNull(fs, target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readJsonFile(fs, file) {
  const handle = await fs.open(file, 'r');
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw storeError('NOT_A_FILE', 'expected a regular file');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function readJsonIfPresent(fs, file) {
  const entry = await lstatOrNull(fs, file);
  if (!entry) return null;
  if (entry.isSymbolicLink() || !entry.isFile()) return null;
  try {
    return await readJsonFile(fs, file);
  } catch {
    return null;
  }
}

async function assertRealDirectory(fs, target) {
  const entry = await lstatOrNull(fs, target);
  if (!entry) return null;
  if (entry.isSymbolicLink()) throw storeError('SYMLINK', 'symbolic links are not followed');
  if (!entry.isDirectory()) throw storeError('NOT_A_DIRECTORY', 'expected a directory');
  return entry;
}

/**
 * `<userData>/practice-calls/<callId>/` (0700) holding call.json, the two WAV
 * tracks, call.m4a and analysis.json. Paths are derived only from validated
 * call ids; every filesystem hop refuses symbolic links.
 */
export function createCallStore({ rootDir, fs = fsPromises } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new TypeError('Practice call store requires an absolute root directory.');
  if (!fs || typeof fs.lstat !== 'function' || typeof fs.mkdir !== 'function') throw new TypeError('Practice call store requires a filesystem.');

  async function ensureRoot() {
    try {
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await assertRealDirectory(fs, rootDir);
    await fs.chmod(rootDir, 0o700);
  }

  async function ensure(callId) {
    const id = checkId(callId);
    await ensureRoot();
    const dir = path.join(rootDir, id);
    const existing = await assertRealDirectory(fs, dir);
    if (!existing) await fs.mkdir(dir, { mode: 0o700 });
    await fs.chmod(dir, 0o700);
    return dir;
  }

  async function dirOf(callId) {
    const id = checkId(callId);
    const dir = path.join(rootDir, id);
    return (await assertRealDirectory(fs, dir)) ? dir : null;
  }

  async function fileOf(callId, name) {
    const dir = await dirOf(callId);
    return dir ? path.join(dir, name) : null;
  }

  let tempSeq = 0;
  async function writeJson(callId, name, value) {
    checkId(callId);
    const dir = await ensure(callId);
    const file = path.join(dir, name);
    const entry = await lstatOrNull(fs, file);
    if (entry?.isSymbolicLink()) throw storeError('SYMLINK', 'symbolic links are not followed');
    // R13: a sibling temp file renamed into place never leaves a half-written record.
    tempSeq += 1;
    const temp = path.join(dir, `.${name}.${process.pid}.${tempSeq}.tmp`);
    try {
      await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, file);
    } catch (error) {
      try { await fs.unlink(temp); } catch { /* temp never existed */ }
      throw error;
    }
    return file;
  }

  /** R8: an abandoned call never reached 'in-call', so its directory is removed whole. */
  async function remove(callId) {
    const dir = await dirOf(callId);
    if (!dir) return { removed: false };
    await fs.rm(dir, { recursive: true, force: true });
    return { removed: true };
  }

  async function readJson(callId, name) {
    const file = await fileOf(callId, name);
    return file ? readJsonIfPresent(fs, file) : null;
  }

  function summarize(callId, record, analysis) {
    return {
      callId,
      startedAt: typeof record?.startedAt === 'number' ? record.startedAt : null,
      durationMs: typeof record?.durationMs === 'number' ? record.durationMs : 0,
      persona: record?.persona ? { name: record.persona.name, role: record.persona.role } : null,
      hasAudio: false,
      analysisStatus: analysis?.status === 'ready' || analysis?.status === 'failed' ? analysis.status : 'missing',
    };
  }

  return Object.freeze({
    rootDir,
    ensure,
    remove,
    callDir: dirOf,
    async readRecord(callId) {
      return readJson(callId, 'call.json');
    },
    async writeRecord(callId, record) {
      return writeJson(callId, 'call.json', record);
    },
    async readAnalysis(callId) {
      return readJson(callId, 'analysis.json');
    },
    async writeAnalysis(callId, analysis) {
      return writeJson(callId, 'analysis.json', analysis);
    },
    async audioPath(callId) {
      return fileOf(callId, 'call.m4a');
    },
    async hasAudio(callId) {
      const file = await fileOf(callId, 'call.m4a');
      const entry = file ? await lstatOrNull(fs, file) : null;
      return !!entry && entry.isFile() && !entry.isSymbolicLink();
    },
    async hasCall(callId) {
      return (await readJson(callId, 'call.json')) !== null;
    },
    async knownCallIds() {
      await ensureRoot();
      const entries = await fs.readdir(rootDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && CALL_ID_RE.test(entry.name))
        .map(entry => entry.name);
    },
    async list(nodeId) {
      if (typeof nodeId !== 'string' || !nodeId) return [];
      const calls = [];
      for (const callId of await this.knownCallIds()) {
        const record = await readJson(callId, 'call.json');
        if (!record || record.nodeId !== nodeId) continue;
        const analysis = await readJson(callId, 'analysis.json');
        const item = summarize(callId, record, analysis);
        item.hasAudio = await this.hasAudio(callId);
        calls.push(item);
      }
      calls.sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0));
      return calls;
    },
    /** Audio only: the transcript, analysis and call record always stay. */
    async deleteRecording(callId) {
      const dir = await dirOf(callId);
      if (!dir) return { deleted: [] };
      const deleted = [];
      for (const name of AUDIO_FILES) {
        const file = path.join(dir, name);
        const entry = await lstatOrNull(fs, file);
        if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
        await fs.unlink(file);
        deleted.push(name);
      }
      return { deleted };
    },
  });
}

export const PRACTICE_CALL_AUDIO_FILES = AUDIO_FILES;
export const isPracticeCallId = value => typeof value === 'string' && CALL_ID_RE.test(value);
