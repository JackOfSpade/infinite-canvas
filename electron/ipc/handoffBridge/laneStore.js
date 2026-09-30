import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LANE_STORE_VERSION = 1;
export const LANES_FILE_NAME = 'lanes.json';
export const LINK_META_FILE_NAME = 'link-meta.json';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const LANE_PHASES = new Set(['unread', 'awaiting', 'host', 'done', 'needs_user', 'held', 'gone']);
const LANE_REASONS = new Set([
  'user_hold', 'human_advance', 'rejection_cap', 'junk_cap', 'review_round_cap',
  'job_broken', 'render_retry', 'canvas_unavailable', 'read_failed', 'write_failed',
  'submit_stuck', 'host_silent', 'lapsed', 'restart',
]);
const COUNTER_KEYS = new Set(['rejections', 'junkStreak', 'revisedRounds', 'errStreak', 'attemptByStage']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownKeysAre(value, allowed) {
  return isObject(value) && Object.keys(value).every(key => allowed.has(key));
}

function lanePathFor(userDataPath, fileName, pathImpl = path) {
  return pathImpl.join(userDataPath, 'handoff-bridge', fileName);
}

export function lanesPathFor(userDataPath, pathImpl = path) {
  return lanePathFor(userDataPath, LANES_FILE_NAME, pathImpl);
}

export function linkMetaPathFor(userDataPath, pathImpl = path) {
  return lanePathFor(userDataPath, LINK_META_FILE_NAME, pathImpl);
}

function safeRead(filePath, fsImpl) {
  try {
    const text = fsImpl.readFileSync(filePath, 'utf8');
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function copyCounters(value, { strict = true } = {}) {
  if (!isObject(value) || (strict && !ownKeysAre(value, COUNTER_KEYS))) return {};
  const counters = {};
  for (const key of ['rejections', 'junkStreak', 'revisedRounds', 'errStreak']) {
    if (!Object.hasOwn(value, key)) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return {};
    counters[key] = value[key];
  }
  if (Object.hasOwn(value, 'attemptByStage')) {
    if (!isObject(value.attemptByStage)) return {};
    const attempts = {};
    for (const stage of Object.keys(value.attemptByStage)) {
      const attempt = value.attemptByStage[stage];
      if (!/^[a-z0-9_@.-]{1,64}$/.test(stage) || !Number.isSafeInteger(attempt) || attempt < 0) return {};
      attempts[stage] = attempt;
    }
    counters.attemptByStage = attempts;
  }
  return counters;
}

function copyLane(value, { strict = true } = {}) {
  const fields = new Set(['ord', 'jobId', 'canvasFilePath', 'releasedAt', 'phase', 'reason', 'heldFrom', 'counters']);
  if (!isObject(value) || (strict && !ownKeysAre(value, fields))
      || !Number.isSafeInteger(value.ord) || value.ord < 1
      || typeof value.jobId !== 'string' || value.jobId.length < 1 || value.jobId.length > 256
      || typeof value.canvasFilePath !== 'string' || value.canvasFilePath.length < 1 || value.canvasFilePath.length > 4096
      || !Number.isSafeInteger(value.releasedAt) || value.releasedAt < 0
      || !LANE_PHASES.has(value.phase)
      || (value.reason !== null && !LANE_REASONS.has(value.reason))
      || (value.heldFrom !== null && !LANE_PHASES.has(value.heldFrom))) return null;
  const counters = copyCounters(value.counters, { strict });
  if (Object.keys(value.counters || {}).length > 0 && Object.keys(counters).length === 0) return null;
  return {
    ord: value.ord,
    jobId: value.jobId,
    canvasFilePath: value.canvasFilePath,
    releasedAt: value.releasedAt,
    phase: value.phase,
    reason: value.reason,
    heldFrom: value.heldFrom,
    counters,
  };
}

// Finished ('done') and vanished ('gone') lanes hold nothing worth keeping:
// there is no bundle left to serve. They are never persisted, and one found in
// an older file is dropped rather than resurrected as a held 'restart' lane
// the person would have to Resume (which produced a snapshot-less lane that
// never aged out). The store cap is therefore the SAME rule the engine
// enforces on release: at most MAX_LIVE_LANES live lanes.
export const MAX_LIVE_LANES = 10;
const TERMINAL_PHASES = new Set(['done', 'gone']);
const isLiveLane = lane => !TERMINAL_PHASES.has(lane?.phase);

function normalizeLanes(value) {
  if (!isObject(value) || value.v !== LANE_STORE_VERSION || !Array.isArray(value.lanes) || value.lanes.length > MAX_LIVE_LANES * 2) return [];
  const seen = new Set();
  const lanes = [];
  for (const item of value.lanes) {
    const lane = copyLane(item);
    if (!lane || seen.has(lane.ord)) return [];
    seen.add(lane.ord);
    if (isLiveLane(lane)) lanes.push(lane);
  }
  return lanes.length > MAX_LIVE_LANES ? [] : lanes;
}

function rehydrateLane(lane, now) {
  const result = copyLane(lane);
  if (!result) return null;
  if (result.phase !== 'held' && result.phase !== 'needs_user') {
    result.heldFrom = result.phase;
    result.phase = 'held';
    result.reason = 'restart';
  }
  // `changedAt` is in-memory only; it lets the engine display a coherent
  // restarted hold without placing any chat or release timestamp on disk.
  result.changedAt = now;
  return result;
}

function copyLinkMeta(value) {
  const fields = new Set(['v', 'linkId', 'toolsSurfaceFp', 'toolsListedAt']);
  if (!ownKeysAre(value, fields) || value.v !== LANE_STORE_VERSION
      || typeof value.linkId !== 'string' || !/^[a-z0-9_-]{1,128}$/.test(value.linkId)
      || typeof value.toolsSurfaceFp !== 'string' || !/^[a-f0-9]{64}$/.test(value.toolsSurfaceFp)
      || !Number.isSafeInteger(value.toolsListedAt) || value.toolsListedAt < 0) return null;
  return {
    v: LANE_STORE_VERSION,
    linkId: value.linkId,
    toolsSurfaceFp: value.toolsSurfaceFp,
    toolsListedAt: value.toolsListedAt,
  };
}

function atomicWrite(filePath, payload, { fsImpl, pathImpl, randomBytes }) {
  const directory = pathImpl.dirname(filePath);
  let descriptor;
  let temporaryPath;
  try {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(directory, 0o700);
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) return false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      temporaryPath = pathImpl.join(directory, `.${pathImpl.basename(filePath)}.${randomBytes(12).toString('hex')}.tmp`);
      try {
        descriptor = fsImpl.openSync(temporaryPath, 'wx', 0o600);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === 7) throw error;
      }
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = fsImpl.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(written) || written < 1) throw new Error('short lane-store write');
      offset += written;
    }
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporaryPath, filePath);
    temporaryPath = undefined;
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(filePath, 0o600);
    if (typeof fsImpl.openSync === 'function' && typeof fsImpl.fsyncSync === 'function') {
      let directoryDescriptor;
      try {
        directoryDescriptor = fsImpl.openSync(directory, fs.constants.O_RDONLY);
        fsImpl.fsyncSync(directoryDescriptor);
      } catch {
        // The data file was already fsynced before rename. Some deterministic
        // fake filesystems cannot open directories and must not turn a durable
        // write into a reported failure after the replacement has happened.
      } finally {
        if (directoryDescriptor !== undefined) {
          try { fsImpl.closeSync(directoryDescriptor); } catch { /* best effort */ }
        }
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* best effort cleanup */ }
    }
    if (temporaryPath) {
      try { fsImpl.unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    }
  }
}

/**
 * Owns only durable application-lane and tool-surface metadata. It never
 * accepts epochs, chat keys, handoff codes, push hubs, prompts or responses.
 */
export function createLaneStore({
  userDataPath,
  fsImpl = fs,
  pathImpl = path,
  randomBytes = crypto.randomBytes,
  clock = Date.now,
} = {}) {
  if (typeof userDataPath !== 'string' || userDataPath.length === 0) throw new TypeError('userDataPath is required');
  const lanesPath = lanesPathFor(userDataPath, pathImpl);
  const linkPath = linkMetaPathFor(userDataPath, pathImpl);
  let chain = Promise.resolve();
  let lastLinkMeta = copyLinkMeta(safeRead(linkPath, fsImpl));

  const enqueue = operation => {
    const task = chain.catch(() => undefined).then(operation);
    chain = task.catch(() => undefined);
    return task;
  };

  const readLanes = () => normalizeLanes(safeRead(lanesPath, fsImpl));
  const loadLanes = (now = clock()) => readLanes().map(lane => rehydrateLane(lane, now)).filter(Boolean);
  const readLinkMeta = () => copyLinkMeta(safeRead(linkPath, fsImpl));

  const saveLanes = lanes => enqueue(() => {
    if (!Array.isArray(lanes)) return false;
    const live = lanes.filter(isLiveLane);
    if (live.length > MAX_LIVE_LANES) return false;
    const persisted = [];
    const seen = new Set();
    for (const candidate of live) {
      // Runtime lanes carry prompts, codes and in-flight state. Persist only
      // the allow-list instead of rejecting those memory-only fields.
      const lane = copyLane(candidate, { strict: false });
      if (!lane || seen.has(lane.ord)) return false;
      seen.add(lane.ord);
      persisted.push(lane);
    }
    return atomicWrite(lanesPath, { v: LANE_STORE_VERSION, lanes: persisted }, { fsImpl, pathImpl, randomBytes });
  });

  const saveLinkMeta = meta => enqueue(() => {
    const next = copyLinkMeta({
      v: LANE_STORE_VERSION,
      linkId: meta?.linkId,
      toolsSurfaceFp: meta?.toolsSurfaceFp,
      toolsListedAt: meta?.toolsListedAt,
    });
    if (!next) return false;
    // A repeated tools/list is deliberately not a write-amplification source.
    // A new link still owns its fingerprint, even if the surface is unchanged.
    if (lastLinkMeta && lastLinkMeta.linkId === next.linkId && lastLinkMeta.toolsSurfaceFp === next.toolsSurfaceFp) return true;
    const written = atomicWrite(linkPath, next, { fsImpl, pathImpl, randomBytes });
    if (written) lastLinkMeta = next;
    return written;
  });

  const dropLinkMeta = () => enqueue(() => {
    try {
      fsImpl.unlinkSync(linkPath);
      lastLinkMeta = null;
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        lastLinkMeta = null;
        return true;
      }
      return false;
    }
  });

  return Object.freeze({
    lanesPath,
    linkPath,
    readLanes,
    loadLanes,
    readLinkMeta,
    saveLanes,
    saveLinkMeta,
    dropLinkMeta,
    flush: () => chain.then(() => true, () => false),
  });
}
