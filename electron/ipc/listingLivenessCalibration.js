import fs from 'node:fs/promises';
import path from 'node:path';
import electronPkg from 'electron';
import { createFifoLock } from './asyncMutex.js';
import { LISTING_LIVENESS_RULES, listingClosedMarkerPresent } from './listingLiveness.js';

const FILE_NAME = 'listing-liveness-calibration.json';
const FORMAT_VERSION = 1;
const MAX_BOARDS = 24;
const MAX_RULES_PER_BOARD = 64;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const COUNTER_NAMES = ['firedAndAiOpen', 'firedAndAiClosed', 'firedAndAiUnclear', 'silentOnAiClosed'];
const emptyCounters = () => ({ firedAndAiOpen: 0, firedAndAiClosed: 0, firedAndAiUnclear: 0, silentOnAiClosed: 0 });
const instant = value => {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
};
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safeInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function defaultRule(rule) {
  return { version: rule.version, ...emptyCounters(), suspendedUntil: null, demotedAt: null, state: 'shadow' };
}

function defaultDocument() {
  const boards = {};
  for (const [board, config] of Object.entries(LISTING_LIVENESS_RULES).slice(0, MAX_BOARDS)) {
    boards[board] = { aiCheckedPages: 0, rules: {} };
    for (const rule of config.openRules.slice(0, MAX_RULES_PER_BOARD)) boards[board].rules[rule.id] = defaultRule(rule);
  }
  return { version: FORMAT_VERSION, boards };
}

function normalizeDocument(raw) {
  const doc = defaultDocument();
  if (!raw || raw.version !== FORMAT_VERSION || !raw.boards || typeof raw.boards !== 'object') return doc;
  for (const [board, entry] of Object.entries(doc.boards)) {
    const storedBoard = raw.boards[board];
    if (!storedBoard || typeof storedBoard !== 'object') continue;
    entry.aiCheckedPages = nonnegativeInteger(storedBoard.aiCheckedPages);
    for (const [id, current] of Object.entries(entry.rules)) {
      const stored = storedBoard.rules?.[id];
      if (!stored || stored.version !== current.version) continue;
      for (const name of COUNTER_NAMES) current[name] = nonnegativeInteger(stored[name]);
      current.suspendedUntil = safeInstant(stored.suspendedUntil);
      current.demotedAt = safeInstant(stored.demotedAt);
      current.state = stored.state === 'active' ? 'active' : 'shadow';
    }
  }
  return doc;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function snapshotOf(doc) {
  const copied = JSON.parse(JSON.stringify(doc));
  const snapshot = {
    ...copied,
    rulesFor(ruleKey) {
      const key = Object.hasOwn(LISTING_LIVENESS_RULES, ruleKey) ? ruleKey : 'generic';
      const base = LISTING_LIVENESS_RULES[key];
      const stored = copied.boards[key]?.rules || {};
      return freezeDeep({ ...base, openRules: base.openRules.map(rule => ({
        ...rule, state: stored[rule.id]?.state === 'active' ? 'active' : 'shadow',
      })) });
    },
    latestDemotedAt(ruleKey) {
      const entry = copied.boards[ruleKey];
      if (!entry) return null;
      return Object.values(entry.rules).map(rule => rule.demotedAt).filter(Boolean).sort().at(-1) || null;
    },
  };
  return freezeDeep(snapshot);
}

/**
 * The calibration file contains only known board/rule ids, versions, counters
 * and timestamps. No page text, job identity, URL or title is persisted.
 */
export function createListingLivenessCalibrationStore(root) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('Calibration root is required');
  const file = root.endsWith('.json') ? root : path.join(root, FILE_NAME);
  const lock = createFifoLock({ name: 'listingLivenessCalibration' });
  let tempSequence = 0;

  async function read() {
    try {
      const text = await fs.readFile(file, 'utf8');
      return normalizeDocument(JSON.parse(text));
    } catch {
      // A missing or corrupt file starts all candidates in shadow. The next
      // accepted answer rewrites a clean bounded document before promotion.
      return defaultDocument();
    }
  }

  async function write(doc) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${++tempSequence}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(doc)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async function snapshot() { return snapshotOf(await read()); }

  async function recordAiAnswer({ ruleKey, evidence = {}, verdict, now = Date.now() } = {}) {
    return lock.withLock(async () => {
      const doc = await read();
      const board = doc.boards[ruleKey];
      if (!board || !['open', 'closed', 'unclear'].includes(verdict)) return { snapshot: snapshotOf(doc), promoted: [], demoted: [] };
      const at = instant(now);
      const eligible = !listingClosedMarkerPresent(evidence, Date.parse(at))
        && evidence.redirectedAway !== true && evidence.titleMatchesPage === true;
      const firedIds = new Set((Array.isArray(evidence.openSignals) ? evidence.openSignals : []).map(signal => signal?.ruleId));
      const promoted = []; const demoted = [];
      board.aiCheckedPages += 1;
      for (const [id, state] of Object.entries(board.rules)) {
        const fired = firedIds.has(id);
        if (verdict === 'closed' && !fired) state.silentOnAiClosed += 1;
        if (!eligible || !fired) continue;
        if (verdict === 'closed') {
          Object.assign(state, emptyCounters(), { state: 'shadow', demotedAt: at });
          demoted.push(id);
        } else if (verdict === 'open') state.firedAndAiOpen += 1;
        else state.firedAndAiUnclear += 1;
      }
      for (const [id, state] of Object.entries(board.rules)) {
        if (state.state !== 'shadow' && !demoted.includes(id)) continue;
        if (state.firedAndAiOpen >= 20 && state.firedAndAiClosed === 0
          && state.silentOnAiClosed >= 5 && board.aiCheckedPages >= 40
          && (!state.suspendedUntil || Date.parse(at) >= Date.parse(state.suspendedUntil))) {
          state.state = 'active';
          promoted.push(id);
        }
      }
      await write(doc);
      return { snapshot: snapshotOf(doc), promoted, demoted };
    });
  }

  async function demoteRule({ ruleKey, ruleId, now = Date.now(), suspendedUntil } = {}) {
    return lock.withLock(async () => {
      const doc = await read();
      const state = doc.boards[ruleKey]?.rules?.[ruleId];
      if (!state) return snapshotOf(doc);
      const at = instant(now);
      Object.assign(state, emptyCounters(), { state: 'shadow', demotedAt: at,
        suspendedUntil: instant(suspendedUntil ?? Date.parse(at) + SEVEN_DAYS_MS) });
      await write(doc);
      return snapshotOf(doc);
    });
  }

  async function latestDemotedAt(ruleKey) { return (await snapshot()).latestDemotedAt(ruleKey); }

  return Object.freeze({ file, snapshot, recordAiAnswer, demoteRule, latestDemotedAt });
}

let productionStore = null;
export function __setListingLivenessCalibrationStoreForTests(store) {
  if (!store || typeof store.snapshot !== 'function') throw new TypeError('A calibration store is required');
  const previous = productionStore;
  productionStore = store;
  let restored = false;
  return () => {
    if (restored) return;
    productionStore = previous;
    restored = true;
  };
}
export function getListingLivenessCalibrationStore() {
  if (!productionStore) productionStore = createListingLivenessCalibrationStore(electronPkg.app.getPath('userData'));
  return productionStore;
}

/** One immutable rule snapshot is installed per capture-capable IPC invocation. */
export async function ensureListingLivenessRules() {
  return getListingLivenessCalibrationStore().snapshot();
}
