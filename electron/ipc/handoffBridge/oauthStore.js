import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const VERSION = 1;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function emptyState() {
  return { v: VERSION, clients: [], codes: [], families: [], refresh: [], access: [] };
}

function safeParse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) return null;
  try {
    const value = JSON.parse(text);
    return isObject(value) && value.v === VERSION ? value : null;
  } catch { return null; }
}

// OAuth acknowledges issuance and revocation only after this synchronous
// writer has fsynced and atomically replaced the state file.
export function createOAuthStore({ filePath, fsImpl = fs, pathImpl = path, randomBytes = crypto.randomBytes } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('filePath is required');

  const read = () => {
    try { return safeParse(fsImpl.readFileSync(filePath, 'utf8')) || emptyState(); }
    catch { return emptyState(); }
  };

  const commit = state => {
    let descriptor;
    let temporary;
    try {
      const directory = pathImpl.dirname(filePath);
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fsImpl.chmodSync(directory, 0o700);
      const persisted = {
        v: VERSION,
        issuer: state?.issuer,
        clients: Array.isArray(state?.clients) ? state.clients : [],
        codes: Array.isArray(state?.codes) ? state.codes : [],
        families: Array.isArray(state?.families) ? state.families : [],
        refresh: Array.isArray(state?.refresh) ? state.refresh : [],
        access: Array.isArray(state?.access) ? state.access : [],
      };
      const data = JSON.stringify(persisted);
      if (Buffer.byteLength(data, 'utf8') > MAX_STATE_BYTES) return false;
      temporary = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
      descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
      const bytes = Buffer.from(data, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const written = fsImpl.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (!Number.isSafeInteger(written) || written <= 0) throw new Error('short OAuth state write');
        offset += written;
      }
      fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      fsImpl.renameSync(temporary, filePath);
      temporary = undefined;
      fsImpl.chmodSync(filePath, 0o600);
      return true;
    } catch {
      try { if (descriptor !== undefined) fsImpl.closeSync(descriptor); } catch { /* best effort */ }
      try { if (temporary) fsImpl.unlinkSync(temporary); } catch { /* best effort */ }
      return false;
    }
  };

  return Object.freeze({ read, commit, flush: () => true, filePath });
}

export const OAUTH_STORE_VERSION = VERSION;
export { MAX_STATE_BYTES };
