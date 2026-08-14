/**
 * Jobs history CSV — minimal record of jobs already shown to the user, used
 * to suppress duplicates on subsequent searches.
 *
 * Format (6 columns):
 *   seen_date,source,company,title,location,url
 *
 * - `seen_date` (YYYY-MM-DD) drives the 60-day cutoff; older rows are pruned
 *   on every append so the file never grows unbounded.
 * - `location` distinguishes multi-req employers (Google, Amazon, etc.) that
 *   post the same title in NYC, SF, etc. as separate reqs — the user can
 *   apply to each independently, so we treat them as distinct listings.
 * - The other fields are the minimum needed to identify a previously-shown
 *   listing across re-runs. No salary/snippet/score/reasoning — those add
 *   no dedup signal and would inflate the file unnecessarily.
 *
 * Legacy 5-column rows (pre-location) are still readable; they just won't
 * match new location-bearing entries, which only risks over-showing once.
 *
 * The file lives next to the canvas JSON so each project keeps its own
 * history. If the canvas has never been saved, history is a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

// "Already seen" retention window for suppressing re-shown jobs. Deliberately a
// fixed midpoint (NOT coupled to the max search window): a longer window stops
// re-showing stale dupes but also suppresses genuine RE-POSTS for longer (dedup
// is on title|company|url, not posting date), so a job reposted after this many
// days correctly resurfaces as new. 60d balances those — left fixed by design.
const MAX_AGE_DAYS = 60;
const SUFFIX = '.jobs-history.csv';
const HEADER = 'seen_date,source,company,title,location,url';
// A count says that a history collision occurred, but not whether it was an
// expected duplicate surfaced by two overlapping queries or a genuinely
// different listing lost to a bad identity key. Keep a small trail for the bug
// report; never retain an unbounded copy of every job in this return value.
const MAX_COLLISION_SAMPLES = 5;

export function historyPathForCanvas(canvasFilePath) {
  if (!canvasFilePath || typeof canvasFilePath !== 'string') return null;
  const dir = path.dirname(canvasFilePath);
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  return path.join(dir, `${base}${SUFFIX}`);
}

// Query params that carry the LISTING IDENTITY on the sources whose URL PATH is
// shared across every listing (see normUrl): `jk` = Indeed, `htidocid` = Google
// for Jobs. Deliberately NOT a list of every source's job-id param — ZipRecruiter
// (`jid`) and Glassdoor (`jl`) already have per-listing paths, and pinning their
// key to a query param that can churn between scrapes would re-show jobs the user
// has already seen. Order is the tie-break if a URL carries more than one.
const IDENTITY_PARAMS = ['jk', 'htidocid'];

function normUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    // Force https and strip leading `www.` so cross-aggregator reposts
    // (e.g. http://indeed.com vs https://www.indeed.com) collapse to one key.
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.toLowerCase().replace(/\/+$/, '');
    // Listing identity normally lives in the PATH, so the query (tracking
    // params, session tokens) is dropped to canonicalize. Indeed inverts that:
    // its scraped links are click-redirect stubs (`/rc/clk`, `/pagead/clk`)
    // where the path is shared across every listing and the identity is the
    // `jk` job-key in the query — while the rest of the query (`bb=`, `xkcb=`)
    // is a session token that changes on every scrape. Dropping the whole
    // query there collapsed EVERY indeed listing to one key, which both
    // under-recorded history (only the first listing wrote a row) and
    // over-suppressed dedup (every later listing looked already-seen). So:
    //   - `jk` present → keep it as the stable identity (path?jk=…)
    //   - redirect stub with no `jk` → '' so dedup falls back to title+company
    //   - everything else → path as before (identity is in the path)
    // Google for Jobs inverts it the same way Indeed does, but worse: EVERY card
    // shares the path `/search` and the listing identity is the `htidocid` query
    // param. Confirmed from a live run — all 10 Google jobs normalized to
    // `https://google.com/search`, so 9 of them were silently dropped from the
    // history write AND every future Google job on that canvas would then match
    // that one poisoned key and be suppressed as "already seen".
    const identity = IDENTITY_PARAMS.find(p => u.searchParams.get(p));
    if (identity) return `https://${host}${path}?${identity}=${u.searchParams.get(identity).toLowerCase()}`;
    if (/\/(?:rc|pagead)\/clk$/.test(path)) return '';
    return `https://${host}${path}`;
  } catch {
    return String(url).split('?')[0].trim().toLowerCase()
      .replace(/^https?:\/\//, 'https://')
      .replace(/^https:\/\/www\./, 'https://')
      .replace(/\/+$/, '');
  }
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function diagnosticText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function collisionJobDiagnostic(job) {
  return {
    source: diagnosticText(job?.source, 50) || '?',
    title: diagnosticText(job?.title) || '(untitled)',
    company: diagnosticText(job?.company) || '(unknown company)',
    location: diagnosticText(job?.location) || '(no location)',
    url: diagnosticText(job?.url, 500) || '(no URL)',
  };
}

function appearsToBeSameListing(first, duplicate) {
  // The shared history key already matches. Matching source and the visible
  // listing fields too is strong evidence that two query paths surfaced the
  // same card, rather than evidence that the history key is too coarse.
  return ['source', 'title', 'company', 'location'].every(
    field => normText(first?.[field]) === normText(duplicate?.[field]),
  );
}

/**
 * A job with a stable listing URL is considered a duplicate only when that URL
 * repeats. A title/company/location tuple is a FALLBACK for records without a
 * usable URL. Treating both as simultaneous keys silently merged distinct,
 * same-employer requisitions in the same city merely because they shared a
 * generic title ("Front Desk Agent" is a common real-world example).
 *
 * Location is part of the key on purpose: a "Software Engineer" req at
 * Google NYC and one at Google SF are separate opportunities — the user
 * may want to apply to both. Same-title rows without a location fall back
 * to (title + company), which only matches other location-less rows, so
 * the worst case is one extra over-show against legacy CSV rows.
 */
export function dedupKeysFor(item) {
  const url = normUrl(item?.url);
  if (url) return [`u:${url}`];
  const keys = [];
  const title = normText(item?.title);
  const company = normText(item?.company);
  const location = normText(item?.location);
  if (title && company) {
    if (location) keys.push(`tcl:${title}|${company}|${location}`);
    else keys.push(`tc:${title}|${company}`);
  }
  return keys;
}

// One record per LINE is a hard invariant here: loadJobsHistory splits the file
// on newlines before it parses fields, so a quoted multi-line value it wrote is
// a value it can never read back. That is not hypothetical — Glassdoor's card
// extractor handed us `company = "Marshalls\n3.4"` (employer name + star rating),
// every such row split into two <5-column fragments on the next read, got dropped
// as unparseable, and was re-appended as "new" on every single run: the CSV grew
// without bound while those jobs were never actually suppressed as seen. The
// extractor bug is fixed at source too, but the format must not be one stray
// newline away from silent data loss — so collapse vertical whitespace on write.
function csvEscape(v) {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, '""');
  return /[,"]/.test(s) ? `"${s}"` : s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function isWithinAge(seenDate, maxAgeDays = MAX_AGE_DAYS) {
  if (!seenDate) return false;
  const d = new Date(seenDate);
  if (isNaN(d.getTime())) return false;
  return (Date.now() - d.getTime()) / 86400000 <= maxAgeDays;
}

/**
 * Read the seen-jobs CSV. `stats`, when passed, is filled in with
 * `{ records, parsed, unreadable }` — `unreadable` being physical records the
 * parser had to discard (a legacy row written before csvEscape collapsed
 * newlines split into <5-column fragments). Callers that don't care omit it.
 */
export async function loadJobsHistory(canvasFilePath, stats = null) {
  const filePath = historyPathForCanvas(canvasFilePath);
  if (!filePath) return [];
  let content;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.info('[JobsHistory] No history file found — treating as fresh start');
    } else {
      logger.warn('[JobsHistory] Read failed:', err.message);
    }
    return [];
  }
  const lines = content.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].toLowerCase();
  const hasHeader = header.startsWith('seen_date');
  // Detect legacy 5-col format (no `location` column) so we map url correctly.
  const isLegacy = hasHeader && !header.includes('location');
  const start = hasHeader ? 1 : 0;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 5) continue;
    if (isLegacy || cols.length < 6) {
      out.push({ seen_date: cols[0], source: cols[1], company: cols[2], title: cols[3], location: '', url: cols[4] });
    } else {
      out.push({ seen_date: cols[0], source: cols[1], company: cols[2], title: cols[3], location: cols[4], url: cols[5] });
    }
  }
  if (stats) {
    const records = lines.length - start;
    Object.assign(stats, {
      records,
      parsed: out.length,
      unreadable: Math.max(0, records - out.length),
    });
  }
  return out;
}

// Per-history-path FIFO mutex. appendJobsHistory is a whole-file
// read-modify-write; without serialization two overlapping appends (the
// fire-and-forget pre-scoring write in search-jobs vs. the renderer's
// post-scoring IPC, or two hubs on one canvas) both read the same baseline and
// the last rename wins — silently dropping the other's rows from the "never
// re-show a job" dedup record. Keyed by path so different canvases never block
// one another. Same dependency-free pattern as jobRunStaging's manifest lock.
const _historyTails = new Map();
function withHistoryLock(filePath, fn) {
  const prev = _historyTails.get(filePath) || Promise.resolve();
  const result = prev.then(fn, fn); // run regardless of the prior op's outcome
  _historyTails.set(filePath, result.then(() => {}, () => {}));
  return result;
}

/**
 * Append new rows to history while pruning entries older than MAX_AGE_DAYS.
 * Returns counts for diagnostics; never throws (logged + skipped on error).
 */
export async function appendJobsHistory(canvasFilePath, jobs) {
  const filePath = historyPathForCanvas(canvasFilePath);
  if (!filePath) return { written: 0, pruned: 0, skipped: 'no-canvas-path' };
  if (!Array.isArray(jobs) || jobs.length === 0) return { written: 0, pruned: 0 };
  return withHistoryLock(filePath, () => appendJobsHistoryLocked(canvasFilePath, filePath, jobs));
}

async function appendJobsHistoryLocked(canvasFilePath, filePath, jobs) {
  try {
    const readStats = {};
    const existing = await loadJobsHistory(canvasFilePath, readStats);
    const fresh = existing.filter(r => isWithinAge(r.seen_date));

    const seen = new Set();
    for (const r of fresh) {
      for (const k of dedupKeysFor(r)) seen.add(k);
    }

    const today = new Date().toISOString().slice(0, 10);
    const newRows = [];
    // WHY a job didn't produce a row, per source and per key kind. A bare
    // "59 jobs → 50 rows" told us nothing: the 9 missing rows turned out to be
    // every Google job colliding on one normalized URL, which took a run of the
    // real data to discover. `url` vs `title+company+location` separates a
    // genuine repost from a normalizer that can't tell two listings apart, and
    // `inBatch` (collided with an EARLIER job in this same write, i.e. not with
    // pre-existing history) is the specific shape that means over-collapsing.
    const skips = { noKey: 0, url: 0, titleCompany: 0, inBatch: 0, bySource: {}, collisionSamples: [] };
    const batchKeys = new Set();
    const batchKeyOwners = new Map();
    const noteSkip = (job, kind, fromBatch, hit = null) => {
      skips[kind]++;
      if (fromBatch) skips.inBatch++;
      const s = String(job?.source || '?');
      skips.bySource[s] = (skips.bySource[s] || 0) + 1;
      const first = fromBatch && hit ? batchKeyOwners.get(hit) : null;
      if (first && skips.collisionSamples.length < MAX_COLLISION_SAMPLES) {
        skips.collisionSamples.push({
          key: diagnosticText(hit, 300),
          first: collisionJobDiagnostic(first),
          duplicate: collisionJobDiagnostic(job),
          sameListing: appearsToBeSameListing(first, job),
        });
      }
    };
    for (const job of jobs) {
      const keys = dedupKeysFor(job);
      if (keys.length === 0) { noteSkip(job, 'noKey', false); continue; }
      const hit = keys.find(k => seen.has(k));
      if (hit) { noteSkip(job, hit.startsWith('u:') ? 'url' : 'titleCompany', batchKeys.has(hit), hit); continue; }
      keys.forEach(k => {
        batchKeys.add(k);
        batchKeyOwners.set(k, job);
      });
      keys.forEach(k => seen.add(k));
      newRows.push({
        seen_date: today,
        source: String(job.source || ''),
        company: String(job.company || ''),
        title: String(job.title || ''),
        location: String(job.location || ''),
        url: String(job.url || ''),
      });
    }

    const pruned = existing.length - fresh.length;
    // `unreadable` catches the other half of the same failure: rows physically in
    // the file that loadJobsHistory could not parse back (a legacy pre-csvEscape
    // multi-line row). They are invisible to dedup AND get dropped by the rewrite
    // below, so the count has to be reported rather than silently absorbed.
    const unreadable = readStats.unreadable || 0;
    if (newRows.length === 0 && pruned === 0 && unreadable === 0) return { written: 0, pruned: 0, skips };

    const all = [...fresh, ...newRows];
    const body = all
      .map(r => [r.seen_date, r.source, r.company, r.title, r.location || '', r.url].map(csvEscape).join(','))
      .join('\n');
    const content = `${HEADER}\n${body}\n`;

    const tmp = `${filePath}.__ic_atomic_${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, filePath);

    return { written: newRows.length, pruned, unreadable, skips };
  } catch (err) {
    logger.warn('[JobsHistory] Append failed:', err?.message || String(err));
    return { written: 0, pruned: 0, error: err?.message || String(err) };
  }
}

/**
 * Drop the history rows a CRASHED run wrote about its own gathered jobs, so
 * resuming that run doesn't dedup-away everything it recovers from staging.
 *
 * search-jobs appends kept jobs to history BEFORE returning (deliberate: an
 * aborted run still marks them seen for FUTURE runs). But a resume of that
 * same run recovers those very jobs from the staging sidecar — left alone,
 * dedupAgainstHistory would collapse the entire recovery to ~0. A history row
 * is exempted only when BOTH hold:
 *   - its seen_date is on/after the resumed run's start day (rows are stamped
 *     at day resolution, so this is the tightest available time scope), AND
 *   - it matches a recovered staged job's dedup key (so a different hub's
 *     same-day completed run keeps suppressing ITS jobs).
 * Jobs the original run itself dropped against OLDER history still carry only
 * pre-run-day rows → still dropped on resume, exactly like the original run.
 * Worst case (an earlier SAME-DAY run had shown one of these jobs) is a single
 * over-show — the stated lesser evil for this pipeline.
 *
 * @param {object[]} historyRows   loadJobsHistory output
 * @param {object[]} recoveredJobs jobs recovered from the run's staging sidecar
 * @param {number}   runStartedAt  the resumed run's manifest.startedAt (ms)
 * @returns {object[]} historyRows minus the resumed run's own appends
 */
export function filterHistoryForResume(historyRows, recoveredJobs, runStartedAt) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  if (!Number.isFinite(runStartedAt) || !Array.isArray(recoveredJobs) || recoveredJobs.length === 0) {
    return rows;
  }
  const runDay = new Date(runStartedAt).toISOString().slice(0, 10);
  const recoveredKeys = new Set();
  for (const j of recoveredJobs) {
    for (const k of dedupKeysFor(j)) recoveredKeys.add(k);
  }
  return rows.filter(r => {
    const sameRunWindow = String(r?.seen_date || '') >= runDay; // YYYY-MM-DD sorts lexicographically
    if (!sameRunWindow) return true;
    return !dedupKeysFor(r).some(k => recoveredKeys.has(k));
  });
}

export function dedupAgainstHistory(jobs, historyRows) {
  const set = new Set();
  for (const r of historyRows) {
    for (const k of dedupKeysFor(r)) set.add(k);
  }
  const kept = [];
  let removed = 0;
  for (const job of jobs) {
    const keys = dedupKeysFor(job);
    if (keys.length > 0 && keys.some(k => set.has(k))) { removed++; continue; }
    kept.push(job);
  }
  return { kept, removed };
}
