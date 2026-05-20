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

const MAX_AGE_DAYS = 60;
const SUFFIX = '.jobs-history.csv';
const HEADER = 'seen_date,source,company,title,location,url';

export function historyPathForCanvas(canvasFilePath) {
  if (!canvasFilePath || typeof canvasFilePath !== 'string') return null;
  const dir = path.dirname(canvasFilePath);
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  return path.join(dir, `${base}${SUFFIX}`);
}

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
    const jk = u.searchParams.get('jk');
    if (jk) return `https://${host}${path}?jk=${jk.toLowerCase()}`;
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

/**
 * A job is considered a duplicate if it shares ANY of these keys with a
 * history row:
 *   - canonical URL (catches the same URL surfaced from different aggregators)
 *   - (title + company + location) (catches reposts with a new URL)
 *
 * Location is part of the key on purpose: a "Software Engineer" req at
 * Google NYC and one at Google SF are separate opportunities — the user
 * may want to apply to both. Same-title rows without a location fall back
 * to (title + company), which only matches other location-less rows, so
 * the worst case is one extra over-show against legacy CSV rows.
 */
export function dedupKeysFor(item) {
  const keys = [];
  const url = normUrl(item?.url);
  if (url) keys.push(`u:${url}`);
  const title = normText(item?.title);
  const company = normText(item?.company);
  const location = normText(item?.location);
  if (title && company) {
    if (location) keys.push(`tcl:${title}|${company}|${location}`);
    else keys.push(`tc:${title}|${company}`);
  }
  return keys;
}

function csvEscape(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return /[,"\n\r]/.test(s) ? `"${s}"` : s;
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

export async function loadJobsHistory(canvasFilePath) {
  const filePath = historyPathForCanvas(canvasFilePath);
  if (!filePath) return [];
  let content;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('[JobsHistory] Read failed:', err.message);
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
  return out;
}

/**
 * Append new rows to history while pruning entries older than MAX_AGE_DAYS.
 * Returns counts for diagnostics; never throws (logged + skipped on error).
 */
export async function appendJobsHistory(canvasFilePath, jobs) {
  const filePath = historyPathForCanvas(canvasFilePath);
  if (!filePath) return { written: 0, pruned: 0, skipped: 'no-canvas-path' };
  if (!Array.isArray(jobs) || jobs.length === 0) return { written: 0, pruned: 0 };

  try {
    const existing = await loadJobsHistory(canvasFilePath);
    const fresh = existing.filter(r => isWithinAge(r.seen_date));

    const seen = new Set();
    for (const r of fresh) {
      for (const k of dedupKeysFor(r)) seen.add(k);
    }

    const today = new Date().toISOString().slice(0, 10);
    const newRows = [];
    for (const job of jobs) {
      const keys = dedupKeysFor(job);
      if (keys.length === 0) continue;
      if (keys.some(k => seen.has(k))) continue;
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
    if (newRows.length === 0 && pruned === 0) return { written: 0, pruned: 0 };

    const all = [...fresh, ...newRows];
    const body = all
      .map(r => [r.seen_date, r.source, r.company, r.title, r.location || '', r.url].map(csvEscape).join(','))
      .join('\n');
    const content = `${HEADER}\n${body}\n`;

    const tmp = `${filePath}.__ic_atomic_${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, filePath);

    return { written: newRows.length, pruned };
  } catch (err) {
    logger.warn('[JobsHistory] Append failed:', err?.message || String(err));
    return { written: 0, pruned: 0, error: err?.message || String(err) };
  }
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
