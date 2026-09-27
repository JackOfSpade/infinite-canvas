import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TUNNEL_CONSTANTS } from './constants.js';
import { ensureTunnelDirectory, tunnelPaths } from './files.js';
import { validateTunnelId } from './validate.js';

const VERSION_RE = /^cloudflared version (\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.]{1,20})?)(?: \(built ([0-9TZ:.-]{10,32})\))?\s*$/;
export const PIN_LIMITS_SENTENCE = 'This pin detects that the file changed; it cannot prove the file is genuine cloudflared: the Homebrew build is ad-hoc signed with no Team ID';

export function findBinary(chosenPath, { existsSync = fs.existsSync } = {}) {
  if (chosenPath) return existsSync(chosenPath) ? chosenPath : null;
  for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) if (existsSync(candidate)) return candidate;
  return null;
}

export function sha256File(target, { fsImpl = fs, cryptoImpl = crypto } = {}) {
  const fd = fsImpl.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const hash = cryptoImpl.createHash('sha256');
  try { const buffer = Buffer.allocUnsafe(64 * 1024); for (;;) { const count = fsImpl.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } return hash.digest('hex'); } finally { try { fsImpl.closeSync?.(fd); } catch { /* cleanup */ } }
}

function safeSource(source, { fsImpl, uid }) {
  // The normal Homebrew entry point is a symlink.  Resolve it first, then
  // inspect/open the resolved file with O_NOFOLLOW so the source itself can
  // never be a symlink at the moment it is copied.
  const link = fsImpl.lstatSync?.(source);
  const stat = fsImpl.statSync(source);
  if (link?.isSymbolicLink?.() || !stat.isFile?.() || !(stat.mode & 0o111) || stat.size < TUNNEL_CONSTANTS.MIN_BINARY_BYTES || stat.size > TUNNEL_CONSTANTS.MAX_BINARY_BYTES || (stat.mode & 0o022) || (uid !== undefined && stat.uid !== 0 && stat.uid !== uid)) throw Object.assign(new Error('unsafe source'), { code: 'binary-unsafe-path' });
  return stat;
}

function safeCopyAncestors(target, { fsImpl, uid }) {
  for (let current = path.dirname(target); current;) {
    const stat = fsImpl.statSync(current);
    if (!stat.isDirectory?.() || (stat.mode & 0o022) || (uid !== undefined && stat.uid !== 0 && stat.uid !== uid)) throw Object.assign(new Error('unsafe copy ancestor'), { code: 'binary-unsafe-path' });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function copyAndHash(source, target, { fsImpl, cryptoImpl, expected }) {
  const hash = cryptoImpl.createHash('sha256');
  const readFd = fsImpl.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let writeFd;
  try {
    const opened = fsImpl.fstatSync?.(readFd);
    if (opened && (!opened.isFile?.() || !(opened.mode & 0o111) || opened.size !== expected.size || opened.uid !== expected.uid || (opened.mode & 0o022))) throw Object.assign(new Error('source changed while opening'), { code: 'binary-unsafe-path' });
    writeFd = fsImpl.openSync(target, 'wx', TUNNEL_CONSTANTS.BINARY_MODE_OCTAL);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = fsImpl.readSync(readFd, buffer, 0, buffer.length, null);
      if (!count) break;
      const chunk = buffer.subarray(0, count); hash.update(chunk);
      for (let offset = 0; offset < chunk.length;) {
        const wrote = fsImpl.writeSync(writeFd, chunk, offset, chunk.length - offset);
        if (!wrote) throw Object.assign(new Error('short copy write'), { code: 'binary-copy-failed' });
        offset += wrote;
      }
    }
    fsImpl.fsyncSync?.(writeFd);
    return hash.digest('hex');
  } finally {
    try { fsImpl.closeSync?.(readFd); } catch { /* cleanup */ }
    try { if (writeFd !== undefined) fsImpl.closeSync?.(writeFd); } catch { /* cleanup */ }
  }
}

export async function prepareBinary({ userData, sourcePath, pin = null, tunnelId = null, testMode = false } = {}, deps = {}) {
  if (tunnelId && !validateTunnelId(tunnelId)) return { ok: false, code: 'binary-unsafe-path' };
  const fsImpl = deps.fsImpl || fs;
  const cryptoImpl = deps.cryptoImpl || crypto;
  const uid = deps.uid ?? process.getuid?.();
  let tempPath = null;
  try {
    const paths = await ensureTunnelDirectory(userData, { fsImpl, uid, ensureDirectory: deps.ensureDirectory });
    // Once a pin exists, the app-owned copy is the source of truth. A missing
    // or upgraded Homebrew source must not disturb an intact approved copy.
    if (/^[0-9a-f]{64}$/.test(pin || '')) {
      const approved = findApprovedCopy({ userData, pin }, { fsImpl, cryptoImpl, uid });
      if (approved.ok) return { ...approved, version: null, approved: true, approvalText: PIN_LIMITS_SENTENCE };
      if (approved.code !== 'binary-copy-missing') return approved;
    }
    const source = fsImpl.realpathSync?.native?.(sourcePath) || fsImpl.realpathSync(sourcePath);
    let sourceStat = null;
    if (!testMode) {
      sourceStat = safeSource(source, { fsImpl, uid });
      const quarantine = deps.xattr?.(source);
      if (quarantine?.present === true || quarantine === true) return { ok: false, code: 'binary-quarantined' };
    }
    const tmp = path.join(paths.bin, `.tmp-${(deps.random || cryptoImpl.randomBytes)(8).toString('hex')}`); tempPath = tmp;
    if (!testMode) safeCopyAncestors(paths.bin, { fsImpl, uid });
    const digest = copyAndHash(source, tmp, { fsImpl, cryptoImpl, expected: sourceStat || fsImpl.statSync(source) });
    fsImpl.chmodSync?.(tmp, TUNNEL_CONSTANTS.BINARY_MODE_OCTAL);
    // Test mode is deliberately narrow: it still copies and pins the copy,
    // but cannot exercise platform signing/quarantine/ancestor facilities.
    // Do not even call those injected ports here: a fake must not accidentally
    // turn a test run into a host inspection.
    if (!testMode) {
      const signature = deps.codesign?.(tmp);
      if (!(signature === true || signature?.verified === true)) throw Object.assign(new Error('signature'), { code: 'binary-signature-invalid' });
    }
    const version = deps.version ? deps.version(tmp) : testMode ? 'cloudflared version 2026.9.3' : null;
    if (!VERSION_RE.test(version)) throw Object.assign(new Error('version'), { code: 'binary-unrecognized' });
    const copyHash = sha256File(tmp, { fsImpl, cryptoImpl });
    if (copyHash !== digest) throw Object.assign(new Error('copy hash'), { code: 'binary-copy-failed' });
    if (pin && pin !== copyHash) throw Object.assign(new Error('copy pin'), { code: 'binary-changed' });
    const copyPath = path.join(paths.bin, `cloudflared-${digest.slice(0, 8)}`);
    // A prior approved copy is immutable and may be reused.  Never overwrite
    // it (the pin stays on the copy), and never let a source upgrade silently
    // replace the approved bytes.
    if (fsImpl.existsSync?.(copyPath)) {
      const approved = findApprovedCopy({ userData, pin: digest }, { fsImpl, cryptoImpl, uid });
      if (!approved.ok) throw Object.assign(new Error('copy collision'), { code: approved.code === 'binary-copy-missing' ? 'binary-copy-failed' : approved.code });
      const existing = approved.sha256;
      try { fsImpl.unlinkSync(tmp); } catch { /* temporary copy cleanup */ } tempPath = null;
      if (pin && pin !== existing) return { ok: false, code: 'binary-changed' };
      return { ok: true, copyPath, sha256: existing, version: VERSION_RE.exec(version)[1], approved: pin === existing, approvalText: PIN_LIMITS_SENTENCE };
    }
    fsImpl.renameSync(tmp, copyPath); tempPath = null;
    return { ok: true, copyPath, sha256: copyHash, version: VERSION_RE.exec(version)[1], approved: pin === copyHash, approvalText: PIN_LIMITS_SENTENCE };
  } catch (error) { if (tempPath) try { fsImpl.unlinkSync(tempPath); } catch { /* cleanup */ } return { ok: false, code: error.code || 'binary-copy-failed' }; }
}

export function verifyPinnedCopy(copyPath, pin, deps = {}) {
  if (!copyPath || !pin) return { ok: false, code: 'binary-untrusted' };
  try {
    const fsImpl = deps.fsImpl || fs; const uid = deps.uid ?? process.getuid?.();
    const link = fsImpl.lstatSync(copyPath); const stat = fsImpl.statSync(copyPath);
    if (link.isSymbolicLink?.() || !stat.isFile?.() || (stat.mode & 0o777) !== TUNNEL_CONSTANTS.BINARY_MODE_OCTAL || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)) return { ok: false, code: 'binary-changed' };
    return sha256File(copyPath, deps) === pin ? { ok: true } : { ok: false, code: 'binary-changed' };
  } catch { return { ok: false, code: 'binary-changed' }; }
}

// Once approved, the copied executable—not its mutable Homebrew source—is the
// sole execution candidate.  Check file identity and permissions before the
// hash so a symlink or a relaxed mode is never accepted as an approved copy.
export function findApprovedCopy({ userData, pin } = {}, deps = {}) {
  if (typeof userData !== 'string' || !/^[0-9a-f]{64}$/.test(pin || '')) return { ok: false, code: 'binary-untrusted' };
  const fsImpl = deps.fsImpl || fs; const uid = deps.uid ?? process.getuid?.();
  const copyPath = path.join(tunnelPaths(userData).bin, `cloudflared-${pin.slice(0, 8)}`);
  try {
    const link = fsImpl.lstatSync(copyPath); const stat = fsImpl.statSync(copyPath);
    if (link.isSymbolicLink?.() || !stat.isFile?.() || (stat.mode & 0o777) !== TUNNEL_CONSTANTS.BINARY_MODE_OCTAL || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)) return { ok: false, code: 'binary-changed' };
    return verifyPinnedCopy(copyPath, pin, deps).ok ? { ok: true, copyPath, sha256: pin } : { ok: false, code: 'binary-changed' };
  } catch (error) { return { ok: false, code: error?.code === 'ENOENT' || /missing/i.test(error?.message || '') ? 'binary-copy-missing' : 'binary-changed' }; }
}
