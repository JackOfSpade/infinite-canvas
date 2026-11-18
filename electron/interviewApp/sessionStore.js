// Saved interviews of the standalone Interview Helper app.
//
// One interview here is what one Interview Helper node was on the canvas: the
// same `interviewHelper*` fields, under the same id, so the Q&A, practice
// history and prepared brief stored per id keep lining up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseWorkspaceText } from '../ipc/workspaceContentPool.js';

const INTERVIEW_SESSIONS_VERSION = 1;
const MAX_SESSIONS = 200;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_CANVAS_BYTES = 512 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/u;
const DATA_KEY = /^(?:interviewHelper[A-Za-z]{1,60}|practiceSteering)$/u;

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => (typeof value === 'string' && value.length <= limit ? value : '');

/** Only the Interview Helper's own fields; canvas-only state (lock, drag cue) is dropped. */
export function interviewSessionData(data) {
  const result = {};
  if (!isRecord(data)) return result;
  for (const [key, value] of Object.entries(data)) {
    if (!DATA_KEY.test(key) || value === undefined || typeof value === 'function') continue;
    result[key] = value;
  }
  return result;
}

function normalizeSession(value) {
  if (!isRecord(value) || !SESSION_ID.test(value.id || '')) return null;
  return {
    id: value.id,
    title: text(value.title, 200).trim(),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
    data: interviewSessionData(value.data),
  };
}

export function normalizeInterviewSessionsState(value) {
  const seen = new Set();
  const sessions = [];
  for (const item of Array.isArray(value?.sessions) ? value.sessions : []) {
    const session = normalizeSession(item);
    if (!session || seen.has(session.id) || sessions.length >= MAX_SESSIONS) continue;
    seen.add(session.id);
    sessions.push(session);
  }
  const folder = text(value?.appliedJobsFolder, 4096);
  return {
    version: INTERVIEW_SESSIONS_VERSION,
    sessions,
    selectedId: seen.has(value?.selectedId) ? value.selectedId : (sessions[0]?.id || null),
    appliedJobsFolder: folder && path.isAbsolute(folder) ? folder : null,
  };
}

export function createInterviewSessionStore({ filePath } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('Interview sessions need an absolute file path.');
  let cached = null;
  let queue = Promise.resolve();
  const serialized = task => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };

  async function read() {
    let raw;
    try { raw = await fs.promises.readFile(filePath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return normalizeInterviewSessionsState(null); throw error; }
    // An unreadable file must not be silently replaced by an empty list on the next save.
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('The saved interviews file is damaged and was left untouched.'); }
    return normalizeInterviewSessionsState(parsed);
  }

  return Object.freeze({
    load: () => serialized(async () => { cached ||= await read(); return structuredClone(cached); }),
    save: state => serialized(async () => {
      const next = normalizeInterviewSessionsState(state);
      const body = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error('The saved interviews are too large to store.');
      // Make sure an existing file was readable before it is ever replaced.
      cached ||= await read();
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.promises.writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
        await fs.promises.rename(temporary, filePath);
      } catch (error) {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      cached = next;
      return structuredClone(next);
    }),
  });
}

function collectInterviewHelperNodes(nodes, found, depth = 0) {
  if (!Array.isArray(nodes) || depth > 32) return;
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (node.type === 'interviewhelper' && SESSION_ID.test(node.id || '')) found.push({ id: node.id, data: interviewSessionData(node.data) });
    // Groups hold a nested canvas.
    collectInterviewHelperNodes(node.data?.canvasData?.nodes, found, depth + 1);
  }
}

/** Read-only: the Interview Helper nodes saved in a canvas file, as interviews. */
export async function readInterviewHelperNodesFromCanvas(canvasPath) {
  if (typeof canvasPath !== 'string' || !path.isAbsolute(canvasPath)) throw new TypeError('A canvas file path is required.');
  const stat = await fs.promises.stat(canvasPath);
  if (!stat.isFile() || stat.size > MAX_CANVAS_BYTES) throw new Error('That file cannot be read as a canvas.');
  let workspace;
  try { workspace = parseWorkspaceText(await fs.promises.readFile(canvasPath, 'utf8')); }
  catch { throw new Error('That file is not a readable Infinite Canvas file.'); }
  const found = [];
  collectInterviewHelperNodes(workspace?.nodes, found);
  return { interviews: found };
}
