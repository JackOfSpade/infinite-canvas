import fs from 'node:fs';
import path from 'node:path';

export const SECURITY_LEDGER_NAME = 'security.jsonl';
export const SERVE_LEDGER_NAME = 'serve.jsonl';

export const SECURITY_AUDIT_EVENTS = Object.freeze([
  'link_created', 'link_replaced', 'link_revoked', 'refresh_reuse', 'code_reuse',
  'pause', 'resume', 'pairing_opened', 'pairing_closed', 'release', 'unrelease',
  'new_chat', 'continue', 'epoch_closed', 'restart_confirmed', 'hostname_change',
  'source_mismatch', 'permit_leak', 'anonymous_summary', 'origin_seen',
]);
export const SERVE_AUDIT_EVENTS = Object.freeze(['served', 'accepted', 'rejected', 'transition']);

const SECURITY_EVENTS = new Set(SECURITY_AUDIT_EVENTS);
const SERVE_EVENTS = new Set(SERVE_AUDIT_EVENTS);
const AUDIT_EVENTS = new Set([...SECURITY_AUDIT_EVENTS, ...SERVE_AUDIT_EVENTS]);
const AUDIT_FIELDS = new Set([
  'tool', 'outcome', 'stage', 'argBytes', 'resultBytes', 'ms', 'grantFp',
  'epochFp', 'source', 'tokenLeftSec', 'reason', 'cause', 'kind',
  'route', 'statusClass', 'count', 'from', 'to', 'clientAuth',
]);
const SAFE_VALUE = /^[a-z0-9_.:/-]{1,40}$/;
// The source-scan import boundary deliberately keeps audit independent of
// composition modules. These are the frozen addendum 4.3 ledger limits.
const SECURITY_LEDGER_MAX_BYTES = 5 * 1024 * 1024;
const SECURITY_LEDGER_KEEP_FILES = 4;
const SERVE_LEDGER_MAX_BYTES = 1 * 1024 * 1024;
const SERVE_LEDGER_KEEP_FILES = 2;
const ANONYMOUS_SUMMARY_INTERVAL_MS = 10 * 60_000;

function copyAuditFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('Audit fields must be an object');
  const safe = {};
  for (const key of Object.keys(fields)) {
    if (!AUDIT_FIELDS.has(key)) throw new TypeError('Unknown audit field');
    const value = fields[key];
    if (typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'string' || !SAFE_VALUE.test(value)) {
      throw new TypeError('Unsafe audit field');
    }
    safe[key] = value;
  }
  return safe;
}

export function makeAuditLine({ at = 0, event, fields = {} } = {}) {
  if (!Number.isFinite(at) || !AUDIT_EVENTS.has(event)) throw new TypeError('Invalid audit event');
  const copied = copyAuditFields(fields);
  const line = { t: Math.floor(at), ev: event };
  for (const key of Object.keys(copied)) line[key] = copied[key];
  return Object.freeze(line);
}

function atomicAppend(filePath, line, { fsImpl, pathImpl }) {
  const directory = pathImpl.dirname(filePath);
  let descriptor;
  try {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(directory, 0o700);
    descriptor = fsImpl.openSync(filePath, 'a', 0o600);
    const bytes = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fsImpl.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(written) || written < 1) throw new Error('short audit write');
      offset += written;
    }
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(filePath, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* best effort cleanup */ }
    }
  }
}

function rotateLedger(filePath, maxBytes, keepFiles, { fsImpl }) {
  let size = 0;
  try { size = fsImpl.statSync(filePath).size; } catch (error) { if (error?.code !== 'ENOENT') return false; }
  if (!Number.isFinite(size) || size < maxBytes) return true;
  try {
    // keepFiles includes the live file: x2 means main + .1, while x4 means
    // main + .1 through .3.
    const lastArchive = keepFiles - 1;
    if (lastArchive >= 1) {
      try { fsImpl.unlinkSync(`${filePath}.${lastArchive}`); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    for (let index = lastArchive - 1; index >= 1; index -= 1) {
      const previous = `${filePath}.${index}`;
      const next = `${filePath}.${index + 1}`;
      try { fsImpl.renameSync(previous, next); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    if (lastArchive >= 1) fsImpl.renameSync(filePath, `${filePath}.1`);
    else fsImpl.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function ledgerPathFor(userDataPath, fileName, pathImpl) {
  return pathImpl.join(userDataPath, 'handoff-bridge', fileName);
}

/**
 * Persist only compact, enumerated audit facts. This never reaches the app
 * logger: anonymous traffic must remain out of its Activity ring entirely.
 */
export function createAuditSink({
  userDataPath,
  fsImpl = fs,
  pathImpl = path,
  clock = Date.now,
} = {}) {
  if (typeof userDataPath !== 'string' || userDataPath.length === 0) {
    // B0 imports this function while disabled. A no-op sink keeps that import
    // inert; enabled composition always supplies a private user-data path.
    return Object.freeze({
      append: () => Promise.resolve(false),
      security: () => Promise.resolve(false),
      serve: () => Promise.resolve(false),
      anonymousSummary: () => Promise.resolve(false),
      flush: () => Promise.resolve(true),
    });
  }
  const securityPath = ledgerPathFor(userDataPath, SECURITY_LEDGER_NAME, pathImpl);
  const servePath = ledgerPathFor(userDataPath, SERVE_LEDGER_NAME, pathImpl);
  let chain = Promise.resolve();
  let anonymousAt = -Infinity;

  const enqueue = operation => {
    const task = chain.catch(() => undefined).then(operation);
    chain = task.catch(() => undefined);
    return task;
  };

  const append = (event, fields = {}, at = clock()) => enqueue(() => {
    const line = makeAuditLine({ at, event, fields });
    const isSecurity = SECURITY_EVENTS.has(event);
    if (!isSecurity && ['waiting', 'queue_empty', 'paused', 'unauthorized'].includes(line.outcome)) return false;
    const filePath = isSecurity ? securityPath : servePath;
    const maxBytes = isSecurity ? SECURITY_LEDGER_MAX_BYTES : SERVE_LEDGER_MAX_BYTES;
    const keepFiles = isSecurity ? SECURITY_LEDGER_KEEP_FILES : SERVE_LEDGER_KEEP_FILES;
    // Each event class rotates only its own ledger. High-volume serve calls
    // can therefore never consume the security forensic window.
    if (!rotateLedger(filePath, maxBytes, keepFiles, { fsImpl })) return false;
    return atomicAppend(filePath, line, { fsImpl, pathImpl });
  });

  const anonymousSummary = (fields = {}, at = clock()) => {
    if (!Number.isFinite(at) || at - anonymousAt < ANONYMOUS_SUMMARY_INTERVAL_MS) return Promise.resolve(false);
    anonymousAt = at;
    return append('anonymous_summary', fields, at);
  };

  return Object.freeze({
    securityPath,
    servePath,
    append,
    security: (event, fields = {}, at = clock()) => SECURITY_EVENTS.has(event) ? append(event, fields, at) : Promise.resolve(false),
    serve: (event, fields = {}, at = clock()) => SERVE_EVENTS.has(event) ? append(event, fields, at) : Promise.resolve(false),
    anonymousSummary,
    flush: () => chain.then(() => true, () => false),
  });
}
