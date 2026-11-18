// Pure helpers for scripts/parallel-render-ab.electron.mjs, which measures how the app's
// hidden browser reads an official job-posting page against Parallel's page reader for the
// same URL. Plain Node ESM with no 'electron' import, so node:test can exercise it without
// a browser, a network or the Keychain. Everything reused from scripts/parallel-extract-ab.mjs
// is imported, not copied: loadCanvasRows, storedPostingUrls, seededShuffle,
// urlKey, median, titleHit, companyHit, closedSignal, USABLE_MIN_CHARS, the Parallel body
// builder and response parser, hostOf and pageFileName.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDurableOutDir, createRunJournal } from './ai-test-journal.mjs';
import {
  PARALLEL_EXTRACT_ENDPOINT, USABLE_MIN_CHARS, closedSignal, companyHit, hostOf, loadCanvasRows, median,
  pageFileName, parallelExtractBody, parseParallelExtract, seededShuffle, storedPostingUrls, titleHit, urlKey,
} from './parallel-extract-ab.mjs';

export { USABLE_MIN_CHARS, loadCanvasRows, storedPostingUrls };
export const GROUPS = Object.freeze(['closed', 'open']);
export const READERS = Object.freeze(['render', 'parallel']);
/** The canvas outcome each group comes from: closed postings are known closed, found ones confirmed open. */
export const GROUP_OUTCOMES = Object.freeze({ closed: 'closed', open: 'found' });
/** A settled page this short that does not name the job is the closure notice, not a posting. */
export const SHORT_PAGE_CHARS = 400;
export const NOT_FOUND_STATUSES = Object.freeze([404, 410]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- arguments -------------------------------------------------------------

/**
 * parseArgs(['--canvas', 'c.json', '--out', '/run', '--closed', '10', '--open', '5', '--seed', '2'])
 * returns every flag with its default filled in; a bad flag throws a one-line error.
 */
export function parseArgs(argv = []) {
  const opts = { canvas: '', out: '', closed: 20, open: 20, seed: 1, dryRun: false };
  const numberFlags = new Map([['--closed', 'closed'], ['--open', 'open'], ['--seed', 'seed']]);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = String(argv[i]);
    if (flag === '--dry-run') { opts.dryRun = true; continue; }
    if (!numberFlags.has(flag) && !['--canvas', '--out'].includes(flag)) throw new Error(`Unknown argument ${flag}.`);
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value.`);
    const value = String(argv[i + 1]);
    i += 1;
    if (numberFlags.has(flag)) {
      if (!/^\d+$/u.test(value)) throw new Error(`${flag} must be a whole number.`);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a whole number.`);
      opts[numberFlags.get(flag)] = parsed;
      continue;
    }
    opts[flag.slice(2)] = value;
  }
  if (!opts.canvas) throw new Error('--canvas <canvas.json> is required.');
  if (!opts.out) throw new Error('--out <dir> is required: a private directory outside the repo.');
  opts.out = path.resolve(opts.out);
  const relative = path.relative(REPO_ROOT, opts.out);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('--out must be outside the repo.');
  return opts;
}

// ---- rows from the canvas --------------------------------------------------

const httpsUrl = (value) => {
  const url = typeof value === 'string' ? value.trim() : '';
  return /^https:\/\/\S+$/iu.test(url) ? url : '';
};

/** The stored posting URL, or — for a known-closed row — its source or apply URL. https only. */
export function postingUrlForRow(row, group) {
  const [stored] = storedPostingUrls(row);
  if (stored) return stored;
  if (group !== 'closed') return '';
  const posting = row?.officialPosting;
  return httpsUrl(posting?.sourceUrl) || httpsUrl(posting?.officialApplyUrl);
}

/**
 * The rows to measure: closed rows (officialPosting.outcome 'closed') and confirmed-open ones
 * ('found'), each with a title, a company and an https posting URL. Deduped by URL across both
 * groups in canvas order, seeded-shuffled per group, then cut to --closed and --open.
 */
export function selectRenderRows(rows, { closed = 20, open = 20, seed = 1 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const eligible = { closed: [], open: [] };
  for (const group of GROUPS) {
    for (const row of list) {
      if (!row || typeof row !== 'object' || row.officialPosting?.outcome !== GROUP_OUTCOMES[group]) continue;
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      const company = typeof row.company === 'string' ? row.company.trim() : '';
      if (!title || !company) continue;
      const url = postingUrlForRow(row, group);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      eligible[group].push({ url, title, company, group });
    }
  }
  const take = (items, count) => seededShuffle(items, seed).slice(0, Math.max(0, Number(count) || 0));
  return { closed: take(eligible.closed, closed), open: take(eligible.open, open),
    eligible: { closed: eligible.closed.length, open: eligible.open.length } };
}

// ---- one read -> one record ------------------------------------------------

/** True when Parallel named this URL under `errors` (its "could not read this page" list). */
export function listedUnderErrors(payload, url) {
  const wanted = urlKey(url);
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  return errors.some(item => item && urlKey(item.url) === wanted);
}

/** A render result ({ ok, status, settled, text } | { ok: false, reason }) as an unclassified read. */
export function renderRead(result, ms = 0) {
  if (!result || typeof result !== 'object') return { ok: false, text: '', error: 'invalid-result', httpStatus: null, settled: false, notFound: false, acquiredAt: '', ms };
  const httpStatus = Number.isFinite(result.status) ? result.status : null;
  if (result.ok !== true) {
    return { ok: false, text: '', error: String(result.reason || 'failed').slice(0, 80), httpStatus, settled: false,
      notFound: NOT_FOUND_STATUSES.includes(httpStatus), acquiredAt: '', ms };
  }
  return { ok: true, text: String(result.text ?? ''), error: '', httpStatus, settled: result.settled === true,
    notFound: NOT_FOUND_STATUSES.includes(httpStatus), acquiredAt: '', ms };
}

/**
 * One Parallel /v1/extract read of the URL: the live body (full content, 10-minute fetch
 * policy) built by parallelExtractBody and parsed by parseParallelExtract. The request itself
 * is sent here so a URL Parallel lists under `errors` is visible as notFound.
 */
export async function readParallelPage(url, { fetchImpl = globalThis.fetch, apiKey = '' } = {}) {
  const started = Date.now();
  const response = await fetchImpl(PARALLEL_EXTRACT_ENDPOINT, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(parallelExtractBody(url, { fetchPolicy: true })) });
  const ms = Date.now() - started;
  const payload = await response.json().catch(() => null);
  const notFound = listedUnderErrors(payload, url);
  if (!response.ok) {
    const code = payload?.errors?.[0]?.error_type || payload?.error?.type || `http-${response.status}`;
    return { ok: false, text: '', error: `parallel:${String(code).slice(0, 60)}`, httpStatus: null, settled: false, notFound, acquiredAt: '', ms };
  }
  const parsed = parseParallelExtract(payload, url);
  return { ok: parsed.ok === true, text: parsed.fullContent, error: parsed.ok === true ? '' : String(parsed.error || 'error').slice(0, 80),
    httpStatus: null, settled: false, notFound, acquiredAt: parsed.acquiredAt ?? '', ms };
}

/** A closed page: says so, is gone, or is too short to be the posting and never names the job. */
export function closedDetected({ ok = false, chars = 0, titleHit: titleMatch = false, closedSignal: signal = false, notFound = false } = {}) {
  return signal === true || notFound === true || (ok === true && Number(chars) < SHORT_PAGE_CHARS && titleMatch !== true);
}

/** One results.jsonl row, identical in shape for both readers. */
export function buildRecord({ url, group, reader, title = '', company = '', read = {} }) {
  const text = String(read.text ?? '');
  const chars = [...text].length;
  const ok = read.ok === true;
  const record = {
    url, group, host: hostOf(url), reader, ok,
    error: ok ? '' : String(read.error || 'error').slice(0, 80),
    httpStatus: reader === 'render' && Number.isFinite(read.httpStatus) ? read.httpStatus : null,
    settled: reader === 'render' ? read.settled === true : null,
    chars, ms: Number.isFinite(read.ms) ? read.ms : 0,
    titleHit: titleHit(text, title), companyHit: companyHit(text, company), closedSignal: closedSignal(text),
    notFound: read.notFound === true || (reader === 'render' && NOT_FOUND_STATUSES.includes(read.httpStatus)),
    acquiredAt: reader === 'parallel' ? String(read.acquiredAt ?? '') : '',
    usable: false, closedDetected: false,
  };
  record.usable = ok && chars >= USABLE_MIN_CHARS && record.titleHit;
  record.closedDetected = closedDetected({ ok, chars, titleHit: record.titleHit, closedSignal: record.closedSignal, notFound: record.notFound });
  return record;
}

// ---- summary ---------------------------------------------------------------

/**
 * Per group and reader: n, ok, usable, closedDetected and medians; per group the 2x2 agreement
 * of closedDetected between the two readers and the URLs only one of them read usably.
 */
export function summarizeRenderAb(records, { groups = GROUPS, readers = READERS } = {}) {
  const list = Array.isArray(records) ? records : [];
  const table = groups.flatMap(group => readers.map((reader) => {
    const mine = list.filter(row => row?.group === group && row?.reader === reader);
    return { group, reader, n: mine.length, ok: mine.filter(row => row.ok === true).length,
      usable: mine.filter(row => row.usable === true).length,
      closedDetected: mine.filter(row => row.closedDetected === true).length,
      medianChars: median(mine.map(row => row.chars)), medianMs: median(mine.map(row => row.ms)) };
  }));
  const agreement = groups.map((group) => {
    const byUrl = new Map();
    for (const row of list) {
      if (row?.group !== group) continue;
      const key = String(row.url ?? '');
      if (!key) continue;
      const entry = byUrl.get(key) ?? {};
      entry[row.reader] = row;
      byUrl.set(key, entry);
    }
    const counts = { group, urls: byUrl.size, both: 0, renderOnly: 0, parallelOnly: 0, neither: 0, usableRenderOnly: 0, usableParallelOnly: 0 };
    for (const entry of byUrl.values()) {
      const render = entry.render?.closedDetected === true;
      const parallel = entry.parallel?.closedDetected === true;
      if (render && parallel) counts.both += 1;
      else if (render) counts.renderOnly += 1;
      else if (parallel) counts.parallelOnly += 1;
      else counts.neither += 1;
      const renderUsable = entry.render?.usable === true;
      const parallelUsable = entry.parallel?.usable === true;
      if (renderUsable && !parallelUsable) counts.usableRenderOnly += 1;
      if (parallelUsable && !renderUsable) counts.usableParallelOnly += 1;
    }
    return counts;
  });
  return { table, agreement };
}

/** The console table: counts and medians only, never page text or a URL. */
export function formatSummary(summary) {
  const lines = [['group', 'reader', 'n', 'ok', 'usable', 'closedDetected', 'medianChars', 'medianMs'].join('\t')];
  for (const row of summary?.table ?? []) {
    lines.push([row.group, row.reader, row.n, row.ok, row.usable, row.closedDetected, row.medianChars, row.medianMs].join('\t'));
  }
  for (const counts of summary?.agreement ?? []) {
    lines.push(`${counts.group}: urls ${counts.urls} · closed both ${counts.both} · render only ${counts.renderOnly}`
      + ` · parallel only ${counts.parallelOnly} · neither ${counts.neither}`
      + ` · usable render only ${counts.usableRenderOnly} · parallel only ${counts.usableParallelOnly}`);
  }
  return lines;
}

// ---- output ----------------------------------------------------------------

const privateDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
};

/** The 0700 --out with its 0700 pages/ beside it, and an empty results.jsonl (0600). */
export function prepareOutDir(outDir) {
  privateDir(outDir);
  const pagesDir = privateDir(path.join(outDir, 'pages'));
  const resultsPath = path.join(outDir, 'results.jsonl');
  fs.writeFileSync(resultsPath, '', { mode: 0o600 });
  fs.chmodSync(resultsPath, 0o600);
  return { outDir, pagesDir, resultsPath };
}

/** One read's text under pages/<pageFileName>.<reader>.txt, 0600. */
export function writePage(pagesDir, url, reader, text) {
  const file = path.join(pagesDir, pageFileName(url, reader));
  fs.writeFileSync(file, String(text ?? ''), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function appendRecord(resultsPath, record) {
  fs.appendFileSync(resultsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function writeSummary(outDir, summary, meta = {}) {
  const file = path.join(outDir, 'summary.json');
  fs.writeFileSync(file, `${JSON.stringify({ ...meta, ...summary }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * The journal, opened the way scripts/parallel-extract-ab.mjs opens one: refuse a throwaway
 * --out, then record the run in docs/ai-test-runs.md and <out>/journal.json.
 */
export function startJournal({ outDir, command = '', opts = {}, task = 'hidden-browser render vs Parallel page reader' }) {
  assertDurableOutDir(outDir);
  return createRunJournal({ tool: 'parallel-render-ab', task, label: 'render,parallel', outDir, command,
    facts: { canvas: path.basename(String(opts.canvas ?? '')), closed: opts.closed, open: opts.open, seed: opts.seed } });
}

export function errorCodeOf(error) {
  const text = String(error?.code || error?.name || error?.message || 'error').replace(/https?:\/\/\S+/giu, '<url>');
  return text.slice(0, 80);
}

// ---- the Electron argv -----------------------------------------------------

/** Electron inserts its own flags before the script, so only what follows the script path counts. */
export function scriptArgs(argv = [], scriptName = 'parallel-render-ab.electron.mjs') {
  const index = argv.findIndex(arg => String(arg).endsWith(scriptName));
  return index >= 0 ? argv.slice(index + 1).map(String) : [];
}
