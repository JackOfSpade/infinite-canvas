import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson, ensureDirectoryWithinRoot } from '../utils/pathSafety.js';
import { EDITORIAL_PLAN_MAX_BYTES, EDITORIAL_PLAN_VERSION, parseEditorialPlanResponse } from './applicationEditorialPlan.js';

const RECORD_VERSION = 1;
const MAX_RECORD_BYTES = EDITORIAL_PLAN_MAX_BYTES + 16 * 1024;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const CATALOG_ID = /^host\.career\.[a-z]+\.[a-z0-9-]+\.[0-9]+$/u;
const RECORD_KEYS = ['version', 'schema', 'jobId', 'laneKey', 'contextKey', 'sourceDigest',
  'writerPromptSha256', 'plan', 'planSha256', 'planRunId', 'planSessionId', 'model', 'createdAt'];

function hash(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }

function boundedText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\u0000');
}

function bindingOf({ jobId, laneKey, contextKey, sourceDigest, allowedIds } = {}) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId) || !boundedText(laneKey, 240)
    || !(contextKey === null || boundedText(contextKey, 512)) || typeof sourceDigest !== 'string' || !SHA256.test(sourceDigest)) {
    throw new Error('Invalid editorial plan archive binding.');
  }
  if ((!Array.isArray(allowedIds) && !(allowedIds instanceof Set)) || (!allowedIds.size && !allowedIds.length)
    || [...allowedIds].some(id => typeof id !== 'string' || !CATALOG_ID.test(id))) {
    throw new Error('Editorial plan archive requires approved catalog IDs.');
  }
  return { jobId, laneKey, contextKey, sourceDigest };
}

async function archiveLocation(args) {
  const binding = bindingOf(args);
  const canvasFilePath = args?.canvasFilePath;
  if (typeof canvasFilePath !== 'string' || !path.isAbsolute(canvasFilePath) || canvasFilePath.includes('\u0000')) {
    throw new Error('Editorial plan archive requires an absolute canvas path.');
  }
  const lexicalRoot = path.dirname(path.resolve(canvasFilePath));
  // This checks the parent itself and its canonical spelling before any
  // private directory is inspected or created. The shared helper recognizes
  // macOS's /tmp and /var aliases but refuses arbitrary symbolic-link parents.
  const root = await ensureDirectoryWithinRoot(lexicalRoot, lexicalRoot, { label: 'Editorial plan archive' });
  const key = hash(JSON.stringify([binding.laneKey, binding.contextKey, binding.sourceDigest]));
  const relativePath = path.join('.local-ai', 'editorial-plans', binding.jobId, `${key}.json`);
  return { root, binding, path: path.join(root, relativePath), relativePath };
}

async function inspectDirectories(location, { create = false } = {}) {
  const directory = path.dirname(location.path);
  if (create) await ensureDirectoryWithinRoot(location.root, directory, { mode: 0o700, label: 'Editorial plan archive' });
  let current = location.root;
  for (const component of path.relative(location.root, directory).split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.promises.lstat(current); }
    catch (error) { if (!create && error?.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(current) !== current) {
      throw new Error('Editorial plan archive must not traverse a symbolic link or non-directory.');
    }
    // Older canvases may already have app-owned directories with the default
    // creation mode. Harden them after validation, before reading any record.
    if ((stat.mode & 0o777) !== 0o700) await fs.promises.chmod(current, 0o700);
  }
  return true;
}

function validateRecord(value, binding, allowedIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== RECORD_KEYS.length || Object.keys(value).some(key => !RECORD_KEYS.includes(key))
    || value.version !== RECORD_VERSION || value.schema !== EDITORIAL_PLAN_VERSION) {
    throw new Error('Invalid editorial plan archive record schema.');
  }
  if (Object.entries(binding).some(([key, expected]) => value[key] !== expected)) {
    throw new Error('Editorial plan archive record does not match the requested binding.');
  }
  if (typeof value.writerPromptSha256 !== 'string' || !SHA256.test(value.writerPromptSha256)
    || typeof value.planSha256 !== 'string' || !SHA256.test(value.planSha256)
    || typeof value.planRunId !== 'string' || !UUID.test(value.planRunId)
    || typeof value.planSessionId !== 'string' || !UUID.test(value.planSessionId)
    || !boundedText(value.model, 200) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.model)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error('Invalid editorial plan archive metadata.');
  }
  const plan = parseEditorialPlanResponse(JSON.stringify(value.plan), allowedIds);
  const planSha256 = hash(JSON.stringify(plan));
  if (value.planSha256 !== planSha256) throw new Error('Editorial plan archive content hash does not match.');
  return { version: RECORD_VERSION, schema: EDITORIAL_PLAN_VERSION, ...binding,
    writerPromptSha256: value.writerPromptSha256, plan, planSha256,
    planRunId: value.planRunId, planSessionId: value.planSessionId, model: value.model, createdAt: value.createdAt };
}

function withLocation(record, location) {
  return { ...record, path: location.path, relativePath: location.relativePath, reference: location.relativePath };
}

async function readRecord(location, allowedIds) {
  if (!await inspectDirectories(location)) return null;
  let stat;
  try { stat = await fs.promises.lstat(location.path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Editorial plan archive record must be a regular file.');
  if (stat.size > MAX_RECORD_BYTES) throw new Error('Editorial plan archive record exceeds its size limit.');
  const handle = await fs.promises.open(location.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('Editorial plan archive record changed while opening.');
    }
    if ((opened.mode & 0o777) !== 0o600) throw new Error('Editorial plan archive record must have private permissions.');
    if (opened.size > MAX_RECORD_BYTES) throw new Error('Editorial plan archive record exceeds its size limit.');
    // Read at most the cap plus one byte even if another process grows this
    // file after stat, so corrupt archives cannot cause an unbounded read.
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > MAX_RECORD_BYTES) throw new Error('Editorial plan archive record exceeds its size limit.');
    text = buffer.subarray(0, bytes).toString('utf8');
  } finally { await handle.close(); }
  let value;
  try {
    value = JSON.parse(text, (key, item) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe object key.');
      return item;
    });
  } catch { throw new Error('Editorial plan archive record contains invalid JSON.'); }
  return withLocation(validateRecord(value, location.binding, allowedIds), location);
}

/** Missing means no completed plan exists. Corruption is always a visible failure. */
export async function loadEditorialPlan(args = {}) {
  return readRecord(await archiveLocation(args), args.allowedIds);
}

/** Publish an immutable retained plan before the writer is allowed to run. */
export async function saveEditorialPlan(args = {}) {
  const location = await archiveLocation(args);
  const plan = parseEditorialPlanResponse(JSON.stringify(args.plan), args.allowedIds);
  const record = validateRecord({ version: RECORD_VERSION, schema: EDITORIAL_PLAN_VERSION, ...location.binding,
    writerPromptSha256: args.writerPromptSha256, plan, planSha256: hash(JSON.stringify(plan)),
    planRunId: args.planRunId, planSessionId: args.planSessionId, model: args.model, createdAt: args.createdAt },
  location.binding, args.allowedIds);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES) throw new Error('Editorial plan archive record exceeds its size limit.');
  await inspectDirectories(location, { create: true });
  const existing = await readRecord(location, args.allowedIds);
  if (existing) {
    const retained = requireSameRecord(existing, record, location);
    await syncArchiveDirectory(location);
    return retained;
  }

  const stagingPath = path.join(path.dirname(location.path), `.${path.basename(location.path)}.${crypto.randomUUID()}.pending`);
  try {
    await atomicWriteJson(stagingPath, record, { mode: 0o600, pretty: false, ensureDir: false });
    const handle = await fs.promises.open(stagingPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    // rename would replace another completed record. A hard-link publication
    // is atomic and fails with EEXIST if any concurrent writer already won.
    try { await fs.promises.link(stagingPath, location.path); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const winner = await readRecord(location, args.allowedIds);
      if (!winner) throw new Error('Editorial plan archive record disappeared during publication.');
      const retained = requireSameRecord(winner, record, location);
      await syncArchiveDirectory(location);
      return retained;
    }
  } finally { await fs.promises.unlink(stagingPath).catch(error => { if (error?.code !== 'ENOENT') throw error; }); }
  await syncArchiveDirectory(location);
  const saved = await readRecord(location, args.allowedIds);
  if (!saved) throw new Error('Editorial plan archive record disappeared after publication.');
  return requireSameRecord(saved, record, location);
}

async function syncArchiveDirectory(location) {
  const directory = await fs.promises.open(path.dirname(location.path), fs.constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

function requireSameRecord(existing, record, location) {
  const clean = Object.fromEntries(RECORD_KEYS.map(key => [key, existing[key]]));
  if (JSON.stringify(clean) !== JSON.stringify(record)) throw new Error('Editorial plan archive already contains a different completed record.');
  return withLocation(record, location);
}
