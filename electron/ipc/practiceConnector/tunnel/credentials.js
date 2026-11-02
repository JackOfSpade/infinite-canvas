import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateCredentialsPath, validateTunnelId } from './validate.js';
import { TUNNEL_CONSTANTS } from './constants.js';
import { tunnelPaths } from './files.js';

const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

export function inspectCredentials(credentialsPath, { fsImpl = fs, uid = process.getuid?.() } = {}) {
  let fd;
  try {
    const original = fsImpl.lstatSync?.(credentialsPath);
    if (original?.isSymbolicLink?.()) return { ok: false, code: 'credentials-invalid' };
    const real = fsImpl.realpathSync?.native?.(credentialsPath) || fsImpl.realpathSync(credentialsPath);
    const filenameId = path.basename(real).replace(/\.json$/, '');
    if (!validateTunnelId(filenameId) || !validateCredentialsPath(real, filenameId)) return { ok: false, code: 'credentials-invalid' };
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fsImpl.openSync(real, flags);
    const stat = fsImpl.fstatSync?.(fd) || fsImpl.statSync(real);
    if (!stat.isFile?.() || stat.size < 64 || stat.size > 4096 || ![0o400, 0o600].includes(stat.mode & 0o777) || (uid !== undefined && stat.uid !== uid)) return { ok: false, code: 'credentials-invalid' };
    const buffer = Buffer.allocUnsafe(Math.min(4096, stat.size));
    const count = fsImpl.readSync(fd, buffer, 0, buffer.length, null);
    // The second fstat makes a concurrent append/truncate fail closed while
    // retaining the fixed 4 KiB read bound.
    const after = fsImpl.fstatSync?.(fd) || stat;
    if (count !== stat.size || after.size !== stat.size || after.uid !== stat.uid || after.mode !== stat.mode) return { ok: false, code: 'credentials-invalid' };
    const raw = buffer.subarray(0, count).toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed.TunnelID !== filenameId || typeof parsed.TunnelSecret !== 'string' || !parsed.TunnelSecret) return { ok: false, code: 'credentials-invalid' };
    return { ok: true, tunnelId: filenameId, credentialsPath: real, credentialsMode: (stat.mode & 0o777) === 0o400 ? '0400' : '0600' };
  } catch { return { ok: false, code: 'credentials-invalid' }; } finally { try { if (fd !== undefined) fsImpl.closeSync?.(fd); } catch { /* cleanup */ } }
}

export function legacyCertPresent(credentialsPath, { fsImpl = fs } = {}) {
  try { return fsImpl.existsSync(path.join(path.dirname(credentialsPath), 'cert.pem')) === true; } catch { return false; }
}

export function recordTunnelIntent(userData, data, { fsImpl = fs, random = crypto.randomBytes } = {}) {
  const preSpawn = data?.pid === null && data?.pgid === undefined && data?.lstart === undefined;
  const live = Number.isInteger(data?.pid) && data.pid > 1 && Number.isInteger(data?.pgid) && data.pgid > 1
    && typeof data.lstart === 'string' && data.lstart.length > 0 && data.lstart.length <= 64;
  const safeConfig = typeof data?.configPath === 'string' && path.isAbsolute(data.configPath) && Buffer.byteLength(data.configPath, 'utf8') <= 1024 && !CONTROL.test(data.configPath);
  if ((!preSpawn && !live) || !safeConfig || !Number.isFinite(data.createdAt)) throw new TypeError('invalid tunnel intent');
  const paths = tunnelPaths(userData); const tmp = `${paths.pid}.tmp-${random(6).toString('hex')}`; let fd;
  try {
    fd = fsImpl.openSync(tmp, 'wx', TUNNEL_CONSTANTS.FILE_MODE_OCTAL);
    const serialized = Buffer.from(JSON.stringify({ v: 1, pid: data.pid, pgid: data.pgid, lstart: data.lstart, configPath: data.configPath, createdAt: data.createdAt }), 'utf8');
    let offset = 0;
    while (offset < serialized.length) {
      const written = fsImpl.writeSync(fd, serialized, offset, serialized.length - offset);
      // writeSync may legally make a short write. A zero, negative,
      // non-integer, or overlong result cannot make forward progress safely.
      if (!Number.isInteger(written) || written <= 0 || written > serialized.length - offset) {
        throw new Error('could not write complete tunnel intent');
      }
      offset += written;
    }
    fsImpl.fsyncSync?.(fd); fsImpl.closeSync?.(fd); fd = null;
    fsImpl.renameSync(tmp, paths.pid); fsImpl.chmodSync?.(paths.pid, TUNNEL_CONSTANTS.FILE_MODE_OCTAL);
    // Durability of the rename matters after a forced quit.  Directory fsync
    // is optional on fake fs ports but used by the real one where supported.
    const dirFd = fsImpl.openSync?.(path.dirname(paths.pid), fs.constants.O_RDONLY);
    try { fsImpl.fsyncSync?.(dirFd); } finally { if (dirFd !== undefined) try { fsImpl.closeSync?.(dirFd); } catch { /* cleanup */ } }
    return paths.pid;
  } catch (error) { try { if (fd !== undefined && fd !== null) fsImpl.closeSync?.(fd); } catch { /* cleanup */ } try { fsImpl.unlinkSync(tmp); } catch { /* cleanup */ } throw error; }
}
