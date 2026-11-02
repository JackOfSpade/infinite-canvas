import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDirectoryWithinRoot } from '../../../utils/pathSafety.js';
import { TUNNEL_CONSTANTS } from './constants.js';
import { validateTunnelConfig } from './validate.js';

const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

export function tunnelPaths(userData) {
  const bridge = path.join(userData, 'handoff-bridge');
  const root = path.join(bridge, 'tunnel');
  return Object.freeze({ bridge, root, bin: path.join(root, 'bin'), config: path.join(root, 'config.yml'), pid: path.join(root, 'tunnel.pid.json'), state: path.join(root, 'tunnel.json') });
}

export async function ensureTunnelDirectory(userData, { fsImpl = fs, uid = process.getuid?.(), ensureDirectory = ensureDirectoryWithinRoot } = {}) {
  const paths = tunnelPaths(userData);
  // The shared helper walks each existing/new component with lstat+realpath;
  // recursive mkdir would otherwise follow a pre-existing tunnel symlink.
  await ensureDirectory(userData, userData, { mode: TUNNEL_CONSTANTS.DIRECTORY_MODE_OCTAL, label: 'Handoff bridge state' });
  await ensureDirectory(userData, paths.bridge, { mode: TUNNEL_CONSTANTS.DIRECTORY_MODE_OCTAL, label: 'Handoff bridge' });
  await ensureDirectory(userData, paths.root, { mode: TUNNEL_CONSTANTS.DIRECTORY_MODE_OCTAL, label: 'Handoff bridge tunnel' });
  await ensureDirectory(userData, paths.bin, { mode: TUNNEL_CONSTANTS.DIRECTORY_MODE_OCTAL, label: 'Handoff bridge tunnel binary' });
  for (const target of [paths.bridge, paths.root, paths.bin]) {
    const stat = fsImpl.lstatSync?.(target) || fsImpl.statSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink?.() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022)) throw Object.assign(new Error('unsafe tunnel directory'), { code: 'binary-unsafe-path' });
    fsImpl.chmodSync?.(target, TUNNEL_CONSTANTS.DIRECTORY_MODE_OCTAL);
  }
  return paths;
}

export function atomicWriteText(target, text, { fsImpl = fs, random = crypto.randomBytes } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new TypeError('invalid atomic text write');
  const temp = `${target}.tmp-${random(6).toString('hex')}`;
  let fd;
  try {
    fd = fsImpl.openSync(temp, 'wx', TUNNEL_CONSTANTS.FILE_MODE_OCTAL);
    fsImpl.writeFileSync(fd, text, 'utf8');
    fsImpl.fsyncSync?.(fd);
    fsImpl.closeSync?.(fd); fd = null;
    fsImpl.renameSync(temp, target);
    fsImpl.chmodSync?.(target, TUNNEL_CONSTANTS.FILE_MODE_OCTAL);
    const directoryFd = fsImpl.openSync?.(path.dirname(target), fs.constants.O_RDONLY);
    try { fsImpl.fsyncSync?.(directoryFd); } finally { if (directoryFd !== undefined) try { fsImpl.closeSync?.(directoryFd); } catch { /* cleanup */ } }
  } catch (error) {
    if (fd !== undefined && fd !== null) try { fsImpl.closeSync?.(fd); } catch { /* best-effort cleanup */ }
    try { fsImpl.unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export async function writeTunnelConfig(userData, input, deps = {}) {
  const valid = validateTunnelConfig(input);
  if (!valid) throw Object.assign(new Error('invalid config'), { code: 'config-rejected' });
  const paths = await ensureTunnelDirectory(userData, deps);
  const { renderTunnelConfig } = deps;
  const text = renderTunnelConfig?.(valid);
  if (typeof text !== 'string') throw Object.assign(new Error('render failed'), { code: 'config-rejected' });
  atomicWriteText(paths.config, text, deps);
  const fsImpl = deps.fsImpl || fs;
  if (fsImpl.readFileSync(paths.config, 'utf8') !== text) throw Object.assign(new Error('config reread failed'), { code: 'config-rejected' });
  return { ...paths, text };
}

// Setup material deliberately lives outside config.json.  These helpers copy
// only the fixed schema; parsed disk data is never spread into live options.
const safeStoredPath = value => typeof value === 'string' && path.isAbsolute(value) && Buffer.byteLength(value, 'utf8') <= 1024 && !CONTROL.test(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * tunnel.json deliberately records setup as it is selected, rather than only
 * once it is start-ready.  That keeps the app-owned binary copy/pin durable
 * across a restart without accidentally treating an unapproved copy as
 * trusted.  `binaryTrusted` is a derived runtime fact and is never serialized.
 */
function normalizeTunnelState(value, { requireVersion = false } = {}) {
  if (!isRecord(value) || (requireVersion && !Object.hasOwn(value, 'v')) || (Object.hasOwn(value, 'v') && value.v !== 1)) return null;
  const hasBinaryPath = Object.hasOwn(value, 'binaryPath');
  const hasPin = Object.hasOwn(value, 'pin');
  const hasCredentials = Object.hasOwn(value, 'credentialsPath');
  const hasApproval = Object.hasOwn(value, 'approvedAt');
  // A hash without its app-owned copy (or vice versa) is never meaningful.
  if (hasBinaryPath !== hasPin) return null;
  if (hasApproval && !hasBinaryPath) return null;
  if (hasBinaryPath && (!safeStoredPath(value.binaryPath) || !/^[0-9a-f]{64}$/.test(value.pin || ''))) return null;
  if (hasCredentials && !safeStoredPath(value.credentialsPath)) return null;
  if (!hasBinaryPath && !hasCredentials) return null;
  // Older complete files always had this field. Treat a missing value on a
  // binary record as an unapproved draft, never as an implicit approval.
  const approvedAt = hasBinaryPath ? (hasApproval ? value.approvedAt : null) : null;
  if (approvedAt !== null && !Number.isFinite(approvedAt)) return null;
  const result = { v: 1 };
  if (hasBinaryPath) {
    result.binaryPath = value.binaryPath;
    result.pin = value.pin;
    result.approvedAt = approvedAt;
  }
  if (hasCredentials) result.credentialsPath = value.credentialsPath;
  result.binaryTrusted = hasBinaryPath && Number.isFinite(approvedAt);
  return Object.freeze(result);
}

export function readTunnelState(userData, { fsImpl = fs, uid = process.getuid?.() } = {}) {
  try {
    const paths = tunnelPaths(userData); const stat = fsImpl.lstatSync?.(paths.state) || fsImpl.statSync(paths.state);
    if (stat.isSymbolicLink?.() || !stat.isFile?.() || stat.size < 2 || stat.size > 16 * 1024 || (stat.mode & 0o777) !== TUNNEL_CONSTANTS.FILE_MODE_OCTAL || (uid !== undefined && stat.uid !== uid)) return null;
    const raw = fsImpl.readFileSync(paths.state, 'utf8'); if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) return null;
    return normalizeTunnelState(JSON.parse(raw), { requireVersion: true });
  } catch { return null; }
}

export async function writeTunnelState(userData, state, deps = {}) {
  const normalized = normalizeTunnelState(state);
  if (!normalized) throw Object.assign(new Error('invalid tunnel state'), { code: 'config-rejected' });
  const paths = await ensureTunnelDirectory(userData, deps);
  // Copy only the schema fields. In particular, no caller-provided trust bit
  // can reach disk and an omitted approval is persisted as an explicit null.
  const stored = { v: 1 };
  if (normalized.binaryPath) {
    stored.binaryPath = normalized.binaryPath;
    stored.pin = normalized.pin;
    stored.approvedAt = normalized.approvedAt;
  }
  if (normalized.credentialsPath) stored.credentialsPath = normalized.credentialsPath;
  const text = JSON.stringify(stored);
  atomicWriteText(paths.state, text, deps);
  return readTunnelState(userData, deps);
}
