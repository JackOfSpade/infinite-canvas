/**
 * Saved listing stream: the one boundary between the Job Search side (which
 * scrapes) and the Job Board side (which scores and shows cards).
 *
 * The Search side appends a record for each listing as soon as it has it. The
 * Board side reads from its own saved position, whenever it runs. Nothing is
 * commanded across this boundary and nothing is shared in memory, so either
 * side can be closed, restarted or rebuilt without stopping the other: the
 * stream on disk is the buffer.
 *
 * Layout, under one stream root:
 *
 *   <root>/<streamKey>/stream.json         { version, streamId, label, createdAt }
 *   <root>/<streamKey>/<YYYY-MM-DD>.jsonl  append-only, one record per line (UTC day)
 *
 * `streamKey` is a fixed-length hash of the stream id (a Job Search module's
 * id), so an unusual id can never escape the root or exceed a name limit.
 *
 * Records (every record has `v`, `type`, `at`):
 *
 *   listing  { key, runId, sourceId, query, queryIndex, page, job }
 *            A listing as scraped. `key` is its stable identity: a later
 *            record with the same key is the same listing, so reading a record
 *            twice is harmless.
 *   update   { key, runId, sourceId, job }
 *            The same listing with more known about it (a description that
 *            arrived later, for example). The reader re-evaluates that card.
 *   status   { code, runId?, sourceId?, ... }
 *            What the Search side is doing ("Glassdoor query 3 of 10", "Indeed
 *            stopped for a check"). Shown read-only by the reader; never a
 *            command. `run-started` carries the run's inputs under `run`.
 *
 * One writer per stream (the app that owns the Search module); any number of
 * readers, each with its own position `{ day, offset }` (a byte offset into
 * that day's file). A reader only consumes complete lines, so a line the
 * writer is still writing is simply read on the next pass. Old day files are
 * removed by age, never by reader confirmation: several readers may be at
 * different positions. A reader whose position names a removed file continues
 * from the oldest file that is left.
 *
 * No Electron imports: the root is always passed in, so this is testable in
 * the plain-node test runner and usable from either app.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';

export const JOB_LISTING_STREAM_VERSION = 1;
export const JOB_LISTING_STREAM_RECORD_TYPES = Object.freeze(['listing', 'update', 'status']);
/** Day files older than this are removed (about 30 days). */
export const JOB_LISTING_STREAM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Most records one read returns, so a long backlog is taken in steps. */
export const JOB_LISTING_STREAM_READ_LIMIT = 500;

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const META_FILE = 'stream.json';

function validStreamId(streamId) {
  return typeof streamId === 'string' && streamId.trim().length > 0 && streamId.length <= 512;
}

/** Folder name for a stream id: fixed length, safe for any id. */
export function jobListingStreamKey(streamId) {
  if (!validStreamId(streamId)) return null;
  return crypto.createHash('sha256').update(streamId, 'utf8').digest('hex').slice(0, 32);
}

function streamDir(root, streamId) {
  const key = jobListingStreamKey(streamId);
  if (!key || typeof root !== 'string' || !path.isAbsolute(root)) return null;
  return path.join(root, key);
}

/** UTC day of a timestamp, as used for day-file names. */
export function jobListingStreamDay(at) {
  const time = Number(at);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The stable identity of a listing in the stream. Two records with the same
 * key are the same listing, whichever run or page they came from.
 */
export function jobListingStreamKeyFor(job) {
  const key = sourceJobKey(job);
  return typeof key === 'string' && key ? key : null;
}

/** The position a new reader starts from: the beginning of everything kept. */
export function jobListingStreamStart() {
  return { day: null, offset: 0 };
}

export function normalizeJobListingStreamPosition(position) {
  const day = typeof position?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(position.day) ? position.day : null;
  const offset = Number.isSafeInteger(position?.offset) && position.offset >= 0 ? position.offset : 0;
  return day ? { day, offset } : jobListingStreamStart();
}

// One append at a time per stream directory within this process. Another
// process never writes the same stream (one writer per stream).
const appendChains = new Map();
function serialized(dir, work) {
  const previous = appendChains.get(dir) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  appendChains.set(dir, next);
  const clear = () => { if (appendChains.get(dir) === next) appendChains.delete(dir); };
  next.then(clear, clear);
  return next;
}

async function ensureStreamMeta(dir, streamId, label, at) {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const metaPath = path.join(dir, META_FILE);
  let meta = null;
  try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')); } catch { meta = null; }
  const wantedLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : (meta?.label || '');
  if (meta?.streamId === streamId && meta.label === wantedLabel) return;
  const next = {
    version: JOB_LISTING_STREAM_VERSION,
    streamId,
    label: wantedLabel,
    createdAt: Number.isFinite(meta?.createdAt) ? meta.createdAt : at,
  };
  const tmp = `${metaPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(tmp, metaPath);
}

function normalizeRecord(record, at) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (!JOB_LISTING_STREAM_RECORD_TYPES.includes(record.type)) return null;
  const base = { v: JOB_LISTING_STREAM_VERSION, type: record.type, at };
  if (record.type === 'status') {
    if (typeof record.code !== 'string' || !record.code) return null;
    const { v: _v, type: _type, at: _at, ...rest } = record;
    return { ...base, ...rest };
  }
  const job = record.job && typeof record.job === 'object' && !Array.isArray(record.job) ? record.job : null;
  if (!job) return null;
  // A row with neither a title nor a link is not a listing anyone can read.
  const named = value => typeof value === 'string' && value.trim().length > 0;
  if (!named(job.title) && !named(job.url)) return null;
  const key = typeof record.key === 'string' && record.key ? record.key : jobListingStreamKeyFor(job);
  if (!key) return null;
  return {
    ...base,
    key,
    runId: typeof record.runId === 'string' ? record.runId : null,
    sourceId: typeof record.sourceId === 'string' ? record.sourceId : (typeof job.source === 'string' ? job.source : null),
    ...(record.type === 'listing' ? {
      query: typeof record.query === 'string' ? record.query : '',
      queryIndex: Number.isSafeInteger(record.queryIndex) ? record.queryIndex : null,
      page: Number.isSafeInteger(record.page) ? record.page : null,
    } : {}),
    job,
  };
}

/**
 * Append records to a stream and make them durable before returning.
 * Returns `{ appended, skipped }`. Records that are not well-formed are
 * skipped and counted, never written. `now` is the caller's timestamp.
 */
export async function appendJobListingStreamRecords(root, streamId, records, { now, label = '' } = {}) {
  const dir = streamDir(root, streamId);
  const at = Number(now);
  if (!dir) throw new Error('A stream root and stream id are required.');
  if (!Number.isFinite(at)) throw new Error('A timestamp is required to append to a listing stream.');
  const list = (Array.isArray(records) ? records : []).map(record => normalizeRecord(record, at));
  const good = list.filter(Boolean);
  const skipped = list.length - good.length;
  if (good.length === 0) return { appended: 0, skipped };
  return serialized(dir, async () => {
    await ensureStreamMeta(dir, streamId, label, at);
    const filePath = path.join(dir, `${jobListingStreamDay(at)}.jsonl`);
    const handle = await fs.promises.open(filePath, 'a+', 0o600);
    try {
      // A crash can leave an unterminated last line. Start on a fresh line so
      // that torn line swallows nothing of this append.
      const { size } = await handle.stat();
      let separator = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) separator = '\n';
      }
      await handle.writeFile(`${separator}${good.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { appended: good.length, skipped };
  });
}

async function dayFiles(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  return names.map(name => DAY_FILE.exec(name)?.[1]).filter(Boolean).sort();
}

/**
 * Read complete records after `position`.
 *
 * Returns `{ records, position, atEnd }`. Each returned record carries
 * `next`: the position just after it, which is what a reader saves once it
 * has fully handled that record. `position` is the position after the last
 * returned record (unchanged when nothing was read). A line that does not
 * parse is passed over; a last line with no newline yet is left for later.
 */
export async function readJobListingStream(root, streamId, position, { limit = JOB_LISTING_STREAM_READ_LIMIT } = {}) {
  const dir = streamDir(root, streamId);
  const max = Math.max(1, Math.floor(Number(limit) || JOB_LISTING_STREAM_READ_LIMIT));
  let current = normalizeJobListingStreamPosition(position);
  const records = [];
  if (!dir) return { records, position: current, atEnd: true };
  const days = await dayFiles(dir);
  if (days.length === 0) return { records, position: current, atEnd: true };
  // A position before the oldest kept file (first read, or its file was
  // removed by age) continues from the oldest file that is left.
  let index = current.day ? days.findIndex(day => day >= current.day) : 0;
  if (index === -1) return { records, position: current, atEnd: true };
  if (days[index] !== current.day) current = { day: days[index], offset: 0 };
  let atEnd = false;
  while (records.length < max) {
    const day = days[index];
    const isNewest = index === days.length - 1;
    let buffer;
    try { buffer = await fs.promises.readFile(path.join(dir, `${day}.jsonl`)); } catch { buffer = Buffer.alloc(0); }
    let offset = Math.min(current.offset, buffer.length);
    let fileDone = false;
    while (records.length < max) {
      if (offset >= buffer.length) { fileDone = true; break; }
      const end = buffer.indexOf(0x0a, offset);
      if (end === -1) {
        // No newline yet. In the newest file the writer may still be writing
        // this line, so leave it for the next read. In an older file the
        // writer has moved on: the line was torn by a crash and is passed over.
        if (!isNewest) offset = buffer.length;
        fileDone = true;
        break;
      }
      const line = buffer.toString('utf8', offset, end).trim();
      offset = end + 1;
      if (!line) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { parsed = null; }
      if (!parsed || !JOB_LISTING_STREAM_RECORD_TYPES.includes(parsed.type)) continue;
      records.push({ ...parsed, next: { day, offset } });
    }
    current = { day, offset };
    if (!fileDone) break; // the read limit was reached inside this file
    if (isNewest) { atEnd = true; break; }
    // The newest file stays the position so later appends to it are read;
    // an older, finished file is left behind.
    index += 1;
    current = { day: days[index], offset: 0 };
  }
  return { records, position: current, atEnd };
}

/** Remove day files older than the retention age. Returns how many were removed. */
export async function pruneJobListingStream(root, streamId, { now, maxAgeMs = JOB_LISTING_STREAM_RETENTION_MS } = {}) {
  const dir = streamDir(root, streamId);
  const at = Number(now);
  if (!dir || !Number.isFinite(at)) return 0;
  const cutoffDay = jobListingStreamDay(at - Math.max(0, Number(maxAgeMs) || 0));
  let removed = 0;
  for (const day of await dayFiles(dir)) {
    // A day file is removed only once the whole day is older than the cutoff.
    if (day >= cutoffDay) continue;
    try { await fs.promises.unlink(path.join(dir, `${day}.jsonl`)); removed += 1; } catch { /* already gone */ }
  }
  return removed;
}

/** Every stream under the root: `{ streamId, label, createdAt }`, oldest first. */
export async function listJobListingStreams(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return [];
  let names;
  try { names = await fs.promises.readdir(root); } catch { return []; }
  const streams = [];
  for (const name of names) {
    if (!/^[a-f0-9]{32}$/u.test(name)) continue;
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(root, name, META_FILE), 'utf8'));
      if (validStreamId(meta?.streamId) && jobListingStreamKey(meta.streamId) === name) {
        streams.push({ streamId: meta.streamId, label: typeof meta.label === 'string' ? meta.label : '', createdAt: Number(meta.createdAt) || 0 });
      }
    } catch { /* not a stream folder */ }
  }
  return streams.sort((a, b) => a.createdAt - b.createdAt || (a.streamId < b.streamId ? -1 : 1));
}

/** Remove a stream entirely (its Search module was deleted). */
export async function removeJobListingStream(root, streamId) {
  const dir = streamDir(root, streamId);
  if (!dir) return false;
  await fs.promises.rm(dir, { recursive: true, force: true });
  return true;
}
