/**
 * Applied-jobs store — the permanent, app-global record of "I applied to this
 * job." Design: docs/resume-achievement-mining-design.md §6.2/§6.3.
 *
 * This is deliberately a SEPARATE store from `jobsHistory.js`, not a variant of
 * it, because the two have opposite lifecycles:
 *   - jobsHistory: canvas-scoped, 60-day-pruned, records jobs merely SHOWN.
 *   - this store:  app-global, NEVER expires, records an explicit "Mark
 *                  applied" action the user takes on purpose.
 * Sharing one file/module for both would mean either the applied record rots
 * off after 60 days (defeats the entire point — a job you applied to a year
 * ago must still be suppressed) or the seen-history stops pruning (defeats
 * ITS point — reposts would never resurface). Two lifecycles, two files.
 *
 * Storage: `app.getPath('userData')/applied-jobs.json`. Deliberately NOT
 * `lazyStore` (electron/utils/lazyStore.js:12-13) — that helper fail-softs and
 * silently DROPS writes when `new Store()` can't construct, which its own
 * doc-comment calls "wrong for critical user data." A dropped write here means
 * a job the user believes is marked applied silently isn't, and it resurfaces
 * in a future search with no error ever shown. So this module uses plain `fs`
 * with real thrown errors, and writes atomically (tmp file + rename) so a
 * crash mid-write can never leave a truncated/corrupt file — the previous
 * good version stays on disk until the new one is fully written.
 *
 * The file is pretty-printed JSON on purpose (see §6.2's "undo matters"): this
 * store is permanent and global, so one misclick (or a bug) makes a posting
 * invisible across every canvas forever with no in-app way to reach it once
 * the card itself is gone. A human-readable, hand-editable file is the safety
 * valve — the user can open it and delete one line.
 *
 * Record shape carries identity + date + destination only — NO status, NO
 * notes, NO monitoring. Job cards are deliberately disposable (see the
 * anti-CRM header comment on JobCardNode.jsx); this store must not become a
 * pipeline-stage tracker or it reopens exactly the invariant that comment
 * protects. Both the raw string (title/company/location/url) and its
 * canonical key are stored side by side so that improving the canonicalizer
 * later (locationIdentity.js) lets existing records be re-keyed instead of
 * silently going stale against a new algorithm.
 *
 * Sync fs, not fs.promises: every exported function here returns its result
 * directly (not a Promise), which also means there is no `await` anywhere
 * inside a read-modify-write — so, unlike jobsHistory.js's async append (which
 * needs an explicit FIFO lock because two overlapping `await`-based appends
 * can interleave), a single synchronous call here can never be interrupted by
 * another IPC call's read-modify-write. No lock needed for that reason alone.
 */
import electronPkg from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { handleSafe } from './ipcUtils.js';
import {
  canonicalizeLocation,
  canonicalizeTitle,
  canonicalizeCompany,
  appliedKeysFor,
  appliedKeysForRecord,
  appliedRecordMatches,
} from '../../src/utils/locationIdentity.js';

const { app } = electronPkg;

const FILE_NAME = 'applied-jobs.json';
const STORE_VERSION = 1;

function appliedJobsFilePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function readStoreSync(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Applied-jobs store at ${filePath} could not be read: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A hand-edit gone wrong (or a torn write that somehow survived — it
    // shouldn't, given the atomic rename below, but "shouldn't" isn't "can't")
    // must NOT be silently treated as an empty store: that would make every
    // prior "mark applied" invisible and every one of those jobs resurface in
    // a future search. Fail loudly so the user notices and can hand-fix the
    // pretty-printed JSON instead of quietly losing months of records.
    throw new Error(`Applied-jobs store at ${filePath} is corrupt (${err.message}). Fix or remove it by hand — it will not be reset automatically.`);
  }
  return Array.isArray(parsed?.records) ? parsed.records : [];
}

function fileSignatureSync(filePath) {
  try {
    const stat = fs.statSync(filePath);
    // inode catches our atomic rename, while ctime/mtime/size catch ordinary
    // hand-edits. This is metadata-only: an unchanged cache pays one stat, not
    // another JSON file read on every search.
    return {
      exists: true,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false };
    throw new Error(`Applied-jobs store at ${filePath} could not be statted: ${err.message}`);
  }
}

function sameFileSignature(a, b) {
  return !!a && !!b
    && a.exists === b.exists
    && (!a.exists || (a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
}

function readStoreSnapshotSync(filePath) {
  // A manual editor can save while we are reading. Re-read once if the file's
  // metadata moved underneath us so the cache never advertises a signature for
  // content from an older revision. Normal use takes one stat + one JSON read.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = fileSignatureSync(filePath);
    const records = readStoreSync(filePath);
    const after = fileSignatureSync(filePath);
    if (sameFileSignature(before, after)) return { records, signature: after };
  }
  // A continuously-changing hand edit is exceptional. Do not cache content
  // whose signature cannot be proven; filterOutApplied will safely leave this
  // run unfiltered and surface a repair/retry warning instead.
  throw new Error(`Applied-jobs store at ${filePath} changed repeatedly while being read. Finish the external edit and retry.`);
}

function writeStoreAtomic(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { version: STORE_VERSION, records };
  // Pretty-printed — see the module doc-comment: this file is a deliberate
  // hand-editable safety valve, not just a serialization format.
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${filePath}.__ic_atomic_${randomUUID()}.tmp`;
  let mode = 0o600;
  try { mode = fs.statSync(filePath).mode & 0o777; }
  catch { /* New stores contain personal history and default to owner-only. */ }
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath); // atomic — a crash here leaves the OLD file intact, never a half-written one.
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
  return fileSignatureSync(filePath);
}

// In-memory cache so `filterOutApplied` (called once per search) does not re-read
// JSON every time. We do stat the file on each lookup, because this deliberately
// hand-editable safety valve must notice an external edit/corruption immediately.
// Every write below replaces the cache directly with the records and the
// post-rename signature it just wrote.
let _cache = null;

export function loadAppliedJobs() {
  const filePath = appliedJobsFilePath();
  const signature = fileSignatureSync(filePath);
  if (!_cache || _cache.path !== filePath || !sameFileSignature(_cache.signature, signature)) {
    const snapshot = readStoreSnapshotSync(filePath);
    _cache = { records: snapshot.records, path: filePath, signature: snapshot.signature };
  }
  return _cache;
}

/**
 * Records an explicit "Mark applied" action. Idempotent by identity: if this
 * job already matches an existing record (a re-mark after undo, or two cards
 * pointing at the same posting), that record is replaced rather than
 * duplicated — the store holds exactly one truth per applied-to job, not a
 * growing pile of re-marks.
 *
 * @param {object} job  the job/listing object (title, company, location, url, source)
 * @param {{ folder?: string }} opts  where the generated application artifacts went
 * @returns {object} the stored record
 */
export function markJobApplied(job, opts = {}) {
  if (!job || typeof job !== 'object') throw new Error('markJobApplied requires a job object.');
  const { records, path: filePath } = loadAppliedJobs();
  const { urlKey } = appliedKeysFor(job);
  const kept = records.filter(r => !appliedRecordMatches(job, r));
  const record = {
    appliedAt: new Date().toISOString(),
    title: String(job.title || ''),
    company: String(job.company || ''),
    location: String(job.location || ''),
    locationKey: canonicalizeLocation(job.location),
    titleKey: canonicalizeTitle(job.title),
    companyKey: canonicalizeCompany(job.company),
    url: String(job.url || ''),
    urlKey,
    source: String(job.source || ''),
    folder: String(opts?.folder || ''),
  };
  const next = [...kept, record];
  const signature = writeStoreAtomic(filePath, next);
  _cache = { records: next, path: filePath, signature };
  logger.info(`[AppliedJobs] Marked applied: ${record.title} @ ${record.company}${record.location ? ` (${record.location})` : ''}`);
  return record;
}

/**
 * Removes every record this job matches (normally exactly one — see the
 * dedup note on markJobApplied). Returns whether anything was actually
 * removed, so the UI's "undo" affordance can tell a real undo from a no-op.
 */
export function unmarkJobApplied(job) {
  if (!job || typeof job !== 'object') return false;
  const { records, path: filePath } = loadAppliedJobs();
  const next = records.filter(r => !appliedRecordMatches(job, r));
  if (next.length === records.length) return false;
  const signature = writeStoreAtomic(filePath, next);
  _cache = { records: next, path: filePath, signature };
  logger.info(`[AppliedJobs] Unmarked applied: ${job.title || ''} @ ${job.company || ''}`);
  return true;
}

export function isJobApplied(job) {
  if (!job || typeof job !== 'object') return false;
  const { records } = loadAppliedJobs();
  return records.some(r => appliedRecordMatches(job, r));
}

/**
 * Drops already-applied jobs from a freshly gathered list, mirroring the
 * seen-history dedup but against the permanent applied store. Called at every
 * job-gathering site (search-jobs, single-source, resolve/resume-job-source —
 * see the design doc's four call sites) so an applied job never resurfaces
 * regardless of which path re-discovers it.
 *
 * O(n+m) via two Sets, not the O(jobs x records) pairwise scan this used to
 * be (appliedRecordMatches re-canonicalizing BOTH sides — NFD normalization
 * plus a dozen regexes — on every single pair). The applied store is app-
 * global and, per the module doc-comment, NEVER EXPIRES: a year of applying
 * to ~500 jobs against a 300-job search used to mean 150,000 pair
 * comparisons, each re-running the full canonicalization pipeline on the
 * SAME record over and over. Computing each record's keys once up front and
 * doing Set lookups per job turns that into (jobs + records) canonicalization
 * calls total.
 *
 * Two invariants from locationIdentity.js are preserved exactly, not just
 * "mostly" — both are load-bearing for the module's core promise that an
 * unknown location is a DIFFERENT job, never a wildcard:
 *   a) EMPTY KEYS NEVER MATCH. An empty urlKey/tupleKey is skipped on BOTH
 *      the record-Set-insert side and the job-lookup side below — Set
 *      membership of '' would otherwise let every location-less/URL-less
 *      job+record pair collide on the shared empty-string entry, which is
 *      exactly the false-positive (a real opening vanishing forever, across
 *      every canvas) this module exists to prevent.
 *   b) RECORDS ARE RE-CANONICALIZED FROM RAW FIELDS every call (via
 *      appliedKeysForRecord, the same helper appliedRecordMatches uses,
 *      not from any persisted urlKey/locationKey) — just once per record
 *      per call instead of once per pair. This keeps the "improving the
 *      canonicalizer later transparently re-keys every stored record with
 *      nothing to migrate" property from locationIdentity.js's
 *      appliedKeysForRecord doc-comment.
 */
export function filterOutApplied(jobs) {
  const arr = Array.isArray(jobs) ? jobs : [];
  let records;
  try {
    ({ records } = loadAppliedJobs());
  } catch (err) {
    // loadAppliedJobs() -> readStoreSync() deliberately THROWS on a corrupt
    // applied-jobs.json (see its own doc-comment) — correct for markJobApplied/
    // unmarkJobApplied, where failing loud on an explicit user action is the
    // point. But filterOutApplied is called unguarded from FOUR gather paths in
    // jobs.js (search-jobs, single-source, resolve-job-source, resume-job-source),
    // each after minutes of scraping/dedup work. Letting the throw propagate used
    // to blow up handleSafe's outer catch and discard the ENTIRE already-gathered
    // `kept` array for a corrupt file the user may not even know exists — turning
    // "delete one bad line" (the store's own documented recovery path) into
    // "every search silently returns zero results forever until you find it."
    // Degrade instead: skip the applied-filter for THIS run only (never drop
    // jobs to fix a file-read problem) and tell the caller why via `error`, so
    // it can surface a visible (non-blocking) warning instead of staying silent.
    logger.error(`[AppliedJobs] filterOutApplied: store unreadable, skipping applied-filter for this run: ${err.message}`);
    return { jobs: arr, hiddenApplied: 0, error: err.message };
  }
  if (arr.length === 0 || records.length === 0) return { jobs: arr, hiddenApplied: 0 };

  const urlKeys = new Set();
  const tupleKeys = new Set();
  for (const record of records) {
    const { urlKey, tupleKey } = appliedKeysForRecord(record);
    if (urlKey) urlKeys.add(urlKey); // empty keys skipped — invariant (a)
    if (tupleKey) tupleKeys.add(tupleKey);
  }

  const kept = [];
  let hiddenApplied = 0;
  for (const job of arr) {
    const { urlKey, tupleKey } = appliedKeysFor(job);
    const matched = (urlKey && urlKeys.has(urlKey)) || (tupleKey && tupleKeys.has(tupleKey));
    if (matched) hiddenApplied++;
    else kept.push(job);
  }
  return { jobs: kept, hiddenApplied };
}

/**
 * Builds the (non-blocking) scrape-warning shown when the applied-jobs store
 * itself failed to load — see filterOutApplied's catch above. Exported so
 * every jobs.js gather site that surfaces it renders identical code/severity/
 * wording instead of four independently-worded copies drifting apart.
 * severity: 'warn' (not 'block'/'info') deliberately — none of the status-
 * deriving branches at the call sites treat 'warn' as anything other than a
 * clean run, matching design doc §3.7/§6.2's "nothing gates" rule: a corrupt
 * applied-store must demote-and-annotate, never block a search that otherwise
 * succeeded.
 */
export function appliedStoreErrorWarning(message) {
  return {
    code: 'applied-store-corrupt',
    severity: 'warn',
    evidence: String(message || '').slice(0, 300),
    suggestion: 'Fix or remove the corrupt applied-jobs.json by hand — results below were NOT filtered against your applied-jobs history until it is fixed.',
  };
}

/** Compact summary for the bug reporter — never dumps full records (identity/PII). */
export function appliedJobsSnapshot() {
  const { records, path: filePath } = loadAppliedJobs();
  let lastAppliedAt = null;
  for (const r of records) {
    // appliedAt is ISO 8601, which sorts lexicographically — no Date parsing needed.
    if (r?.appliedAt && (!lastAppliedAt || r.appliedAt > lastAppliedAt)) lastAppliedAt = r.appliedAt;
  }
  return { count: records.length, path: filePath, lastAppliedAt };
}

export function registerAppliedJobsHandlers() {
  handleSafe('mark-job-applied', async (_event, { job, folder } = {}) => {
    if (!job) throw new Error('mark-job-applied requires a job.');
    const record = markJobApplied(job, { folder });
    return { record };
  });

  handleSafe('unmark-job-applied', async (_event, { job } = {}) => {
    if (!job) throw new Error('unmark-job-applied requires a job.');
    const removed = unmarkJobApplied(job);
    return { removed };
  });

  handleSafe('load-applied-jobs', async () => {
    const { records } = loadAppliedJobs();
    return { records, count: records.length };
  });

  // Mount-time hydration for JobCardNode's "Applied ✓ · undo" button (design
  // doc §6.2). `isJobApplied` has existed since this module was written but
  // was never wired to an ipcMain handler — nothing under src/ could reach it,
  // so a reloaded canvas always showed "Mark applied" for a job that was
  // already permanently recorded, silently misrepresenting persisted state
  // back to the user (exactly what §6.2's "never silent" undo design exists
  // to prevent).
  handleSafe('is-job-applied', async (_event, { job } = {}) => {
    if (!job) throw new Error('is-job-applied requires a job.');
    return { applied: isJobApplied(job) };
  });
}
