#!/usr/bin/env node
// Measures how well three readers read official job-posting pages, for the same rows:
//   app              the app's own plain download (fetchOfficialPosting) and the page text
//                    the snapshot code derives from it (officialPostingSnapshot.js)
//   parallel-live    Parallel /v1/extract, full content and a 10-minute fetch policy
//   parallel-default the same request without fetch_policy
// Plain Node ESM: it never launches Electron. Reads a private canvas (counts only on the
// console), writes results.jsonl, pages/<sha1(url)>.<arm>.txt and summary.json under a
// private --out outside the repo (0700 dir, 0600 files), and journals the run like the
// other measurement scripts. Console output is counts only: never page text, full URLs
// or the API key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDurableOutDir, createRunJournal } from './ai-test-journal.mjs';
import { fetchOfficialPosting } from '../electron/ipc/officialPostingFetch.js';
import { snapshotOfficialPostingLead } from '../electron/ipc/officialPostingSnapshot.js';
import { readParallelKey } from '../electron/ipc/parallelSearch.js';
import { mulberry32, shuffle } from './lib/seeded-random.mjs';

export const ARMS = Object.freeze(['app', 'parallel-live', 'parallel-default']);
export const PARALLEL_EXTRACT_ENDPOINT = 'https://api.parallel.ai/v1/extract';
export const PARALLEL_OBJECTIVE = 'The full text of this job posting page.';
export const USABLE_MIN_CHARS = 600;
export const TITLE_HIT_RATIO = 0.6;
const CLOSED_SIGNAL = /no longer (available|accepting)|position (has been )?(filled|closed)|job (is )?(closed|expired)|not accepting applications/iu;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- arguments -------------------------------------------------------------

/**
 * parseArgs(['--canvas', 'c.json', '--out', '/tmp/run', '--count', '10', '--dry-run'])
 * returns every flag with its default filled in; a bad flag throws a one-line error.
 */
export function parseArgs(argv = []) {
  const opts = { canvas: '', out: '', count: 40, seed: 1, concurrency: 4, arms: [...ARMS], dryRun: false };
  const numberFlags = new Map([['--count', 'count'], ['--seed', 'seed'], ['--concurrency', 'concurrency']]);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = String(argv[i]);
    if (flag === '--dry-run') { opts.dryRun = true; continue; }
    if (!numberFlags.has(flag) && !['--canvas', '--out', '--arms'].includes(flag)) throw new Error(`Unknown argument ${flag}.`);
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value.`);
    const value = String(argv[i + 1]);
    i += 1;
    if (numberFlags.has(flag)) {
      if (!/^-?\d+$/u.test(value)) throw new Error(`${flag} must be a whole number.`);
      const minimum = flag === '--seed' ? 0 : 1;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${flag} must be a whole number of at least ${minimum}.`);
      opts[numberFlags.get(flag)] = parsed;
      continue;
    }
    if (flag === '--arms') {
      const arms = [...new Set(value.split(',').map(arm => arm.trim()).filter(Boolean))];
      if (!arms.length) throw new Error('--arms needs at least one arm.');
      const unknown = arms.find(arm => !ARMS.includes(arm));
      if (unknown) throw new Error(`Unknown arm ${unknown}; choose from ${ARMS.join(', ')}.`);
      opts.arms = arms;
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

// ---- text checks -----------------------------------------------------------

const wordParts = text => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const containsWord = (haystack, word) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'u').test(haystack);
// Words that name a legal form or a leading article, not the company.
const COMPANY_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'inc', 'llc', 'ltd', 'corp', 'corporation',
  'company', 'co', 'group', 'holdings', 'technologies', 'solutions', 'services', 'international', 'global']);

/** At least 60% of the title's words of 3+ letters appear in the text, case-insensitive. */
export function titleHit(text, title) {
  const body = String(text ?? '').toLowerCase();
  if (!body.trim()) return false;
  const words = [...new Set(wordParts(title).filter(word => [...word].length >= 3 && /\p{L}/u.test(word)))];
  if (!words.length) return false;
  const found = words.filter(word => containsWord(body, word)).length;
  return found / words.length >= TITLE_HIT_RATIO;
}

/** The company name's first significant word (in the text), case-insensitive. */
export function companyHit(text, company) {
  const body = String(text ?? '').toLowerCase();
  if (!body.trim()) return false;
  const word = wordParts(company).find(part => [...part].length >= 3 && /\p{L}/u.test(part) && !COMPANY_STOPWORDS.has(part));
  return Boolean(word) && containsWord(body, word);
}

/** A sentence on the page saying the job is closed or no longer accepting applications. */
export function closedSignal(text) {
  return CLOSED_SIGNAL.test(String(text ?? ''));
}

/** A read counts as usable only when it succeeded, carried enough text and names the job. */
export function classifyUsable({ ok = false, chars = 0, titleHit: titleMatch = false } = {}) {
  return ok === true && Number(chars) >= USABLE_MIN_CHARS && titleMatch === true;
}

// ---- rows from the canvas --------------------------------------------------

/** A seeded mulberry32 generator; the seed is coerced with Number() and a non-number draws from seed 0. */
export function seededRandom(seed) {
  return mulberry32(Number(seed) || 0);
}

/** Fisher-Yates with a seeded generator, so --seed picks the same rows every run. */
export function seededShuffle(items, seed) {
  return shuffle(Array.isArray(items) ? items : [], seededRandom(seed));
}

// scripts/ai-task-replay.mjs exports storedPostingUrls, but importing it would load the whole
// replay harness and its Electron IPC modules; this is the same URL list, minimal.
export function storedPostingUrls(row) {
  const posting = row?.officialPosting;
  if (!posting || typeof posting !== 'object') return [];
  const urls = [];
  const add = (value) => {
    const url = typeof value === 'string' ? value.trim() : '';
    if (/^https:\/\/\S+$/iu.test(url) && !urls.includes(url)) urls.push(url);
  };
  add(posting.sourceUrl);
  add(posting.officialApplyUrl);
  for (const alternative of Array.isArray(posting.alternatives) ? posting.alternatives : []) add(alternative?.url);
  return urls;
}

/**
 * Rows whose stored official posting is confirmed (outcome 'found'), with an https posting
 * URL and a title and company, deduped by URL, in canvas order.
 */
export function eligiblePostingRows(rows) {
  const seen = new Set();
  const eligible = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || row.officialPosting?.outcome !== 'found') continue;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const company = typeof row.company === 'string' ? row.company.trim() : '';
    if (!title || !company) continue;
    const [url] = storedPostingUrls(row);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    eligible.push({ url, title, company });
  }
  return eligible;
}

/** The eligible rows, seeded-shuffled and cut to --count. */
export function selectPostingRows(rows, { count = 40, seed = 1 } = {}) {
  const take = Math.max(0, Number(count) || 0);
  return seededShuffle(eligiblePostingRows(rows), seed).slice(0, take);
}

// ---- summary ---------------------------------------------------------------

export const median = (values) => {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * Per-arm counts and medians, plus each ordered arm pair: URLs usable in A but not B, and
 * (among URLs usable in both) the count where closedSignal differs. Rows must carry `url`.
 */
export function summarize(rows, { arms = ARMS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const table = arms.map((arm) => {
    const mine = list.filter(row => row?.arm === arm);
    return { arm, n: mine.length, ok: mine.filter(row => row.ok === true).length,
      usable: mine.filter(row => row.usable === true).length, titleHit: mine.filter(row => row.titleHit === true).length,
      medianChars: median(mine.map(row => row.chars)), medianMs: median(mine.map(row => row.ms)),
      closedSignal: mine.filter(row => row.closedSignal === true).length };
  });
  const pairwise = [];
  for (const a of arms) {
    for (const b of arms) {
      if (a === b) continue;
      const byUrl = new Map();
      for (const row of list) {
        if (row?.arm !== a && row?.arm !== b) continue;
        const key = String(row.url ?? row.urlKey ?? '');
        if (!key) continue;
        const entry = byUrl.get(key) ?? {};
        entry[row.arm] = row;
        byUrl.set(key, entry);
      }
      let usableInANotB = 0;
      let closedSignalDiffers = 0;
      for (const entry of byUrl.values()) {
        const inA = entry[a]?.usable === true;
        const inB = entry[b]?.usable === true;
        if (inA && !inB) usableInANotB += 1;
        if (inA && inB && entry[a].closedSignal !== entry[b].closedSignal) closedSignalDiffers += 1;
      }
      pairwise.push({ a, b, usableInANotB, closedSignalDiffers });
    }
  }
  return { arms: table, pairwise };
}

// ---- Parallel --------------------------------------------------------------

export const urlKey = url => String(url ?? '').trim().replace(/#.*$/u, '').replace(/\/+$/u, '').toLowerCase();

/** The documented /v1/extract body; live also sets fetch_policy, default leaves it out. */
export function parallelExtractBody(url, { fetchPolicy = true } = {}) {
  return { urls: [url], objective: PARALLEL_OBJECTIVE,
    advanced_settings: { full_content: true, ...(fetchPolicy ? { fetch_policy: { max_age_seconds: 600 } } : {}) } };
}

/** The request body one arm sends; the app arm is a plain download, so it has none. */
export function armRequestBody(arm, url) {
  if (arm === 'parallel-live') return parallelExtractBody(url, { fetchPolicy: true });
  if (arm === 'parallel-default') return parallelExtractBody(url, { fetchPolicy: false });
  throw new Error(`Arm ${arm} sends no Parallel request.`);
}

/**
 * One verified response ({ results: [{ url, title, excerpts, full_content, acquired_at }],
 * errors: [{ url, error_type }] }) as a read: ok only with a matching result and non-empty
 * full_content. A URL listed in errors is a failed read even if a result also came back.
 */
export function parseParallelExtract(payload, url) {
  const invalid = { ok: false, fullContent: '', acquiredAt: '', title: '', error: 'invalid-response' };
  if (!payload || typeof payload !== 'object') return invalid;
  const wanted = urlKey(url);
  const results = Array.isArray(payload.results) ? payload.results : [];
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const result = results.find(item => item && urlKey(item.url) === wanted) ?? null;
  const fullContent = typeof result?.full_content === 'string' ? result.full_content : '';
  const acquiredAt = typeof result?.acquired_at === 'string' ? result.acquired_at : '';
  const title = typeof result?.title === 'string' ? result.title : '';
  const listed = errors.find(item => item && urlKey(item.url) === wanted) ?? null;
  if (listed) return { ok: false, fullContent, acquiredAt, title, error: `parallel:${String(listed.error_type || 'error').slice(0, 60)}` };
  if (!result) return { ...invalid, acquiredAt, title };
  if (!fullContent.trim()) return { ok: false, fullContent: '', acquiredAt, title, error: 'empty-content' };
  return { ok: true, fullContent, acquiredAt, title };
}

// ---- the three readers -----------------------------------------------------

/**
 * The text the snapshot code would hand the judges: the matched posting's description
 * (postingFacts) when the page carried one, otherwise the page text it extracted.
 */
export function appSnapshotText(snapshot) {
  const description = typeof snapshot?.description === 'string' ? snapshot.description.trim() : '';
  if (description) return description;
  return typeof snapshot?.pageText === 'string' ? snapshot.pageText.trim() : '';
}

/**
 * Why a plain download is unusable, or '' when it is: not read (404/410/closed become
 * not-found, other statuses http-<status>, transport errors unreadable), or read but an
 * empty shell with neither a match nor page text.
 */
export function appSnapshotError(snapshot) {
  if (snapshot?.read !== true) {
    if (snapshot?.notFound === true) return 'not-found';
    if (Number.isFinite(snapshot?.httpStatus)) return `http-${snapshot.httpStatus}`;
    return 'unreadable';
  }
  return appSnapshotText(snapshot) ? '' : 'empty-page';
}

/** The app arm: the same plain download and snapshot derivation the app itself uses. */
export async function readAppArm(url, { fetchPosting = fetchOfficialPosting, signal } = {}) {
  const started = Date.now();
  const snapshot = await snapshotOfficialPostingLead({ id: 'posting', url, kind: 'posting' }, { fetch: fetchPosting, signal });
  const error = appSnapshotError(snapshot);
  return { ok: error === '', text: error ? '' : appSnapshotText(snapshot), error, ms: Date.now() - started, acquiredAt: '' };
}

/** One Parallel arm: the documented POST, then the verified response shape as a read. */
export async function readParallelArm(arm, url, { fetchImpl = globalThis.fetch, apiKey = '' } = {}) {
  const started = Date.now();
  const response = await fetchImpl(PARALLEL_EXTRACT_ENDPOINT, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(armRequestBody(arm, url)) });
  const ms = Date.now() - started;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.errors?.[0]?.error_type || payload?.error?.type || `http-${response.status}`;
    return { ok: false, text: '', error: `parallel:${String(code).slice(0, 60)}`, ms, acquiredAt: '' };
  }
  const parsed = parseParallelExtract(payload, url);
  return { ...parsed, text: parsed.fullContent, ms };
}

export function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ''; }
}

/** picks one file per URL and arm; sha1 keeps the posting URL out of the filename. */
export function pageFileName(url, arm) {
  return `${crypto.createHash('sha1').update(String(url)).digest('hex')}.${arm}.txt`;
}

// ---- canvas + output -------------------------------------------------------

const ROW_ARRAYS = new Set(['scoredJobs', 'rows', 'jobs']);

/** Every object under a scoredJobs/rows/jobs array anywhere in the canvas, deduped. */
export function canvasJobRows(canvas) {
  const out = [];
  const pushed = new Set();
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 12) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    for (const [key, child] of Object.entries(value)) {
      if (ROW_ARRAYS.has(key) && Array.isArray(child)) {
        for (const row of child) if (row && typeof row === 'object' && !pushed.has(row)) { pushed.add(row); out.push(row); }
      }
      visit(child, depth + 1);
    }
  };
  visit(canvas, 0);
  return out;
}

/** Loads the canvas the way scripts/ai-task-replay.mjs does (restore a pooled canvas first). */
export async function loadCanvasRows(canvasPath, modules = {}) {
  const pool = modules.pool ?? await import(new URL('../electron/ipc/workspaceContentPool.js', import.meta.url).href);
  const parsed = pool.parseWorkspaceText(fs.readFileSync(canvasPath, 'utf8'));
  const canvas = pool.restoreWorkspaceContent(parsed) ?? parsed;
  return canvasJobRows(canvas);
}

function prepareOutDir(outDir) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700);
  const pagesDir = path.join(outDir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(pagesDir, 0o700);
  return pagesDir;
}

async function runPool(items, limit, work) {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await work(items[current]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

const noUrls = text => String(text ?? '').replace(/https?:\/\/\S+/giu, '<url>');
const errorCodeOf = error => noUrls(error?.code || error?.name || error?.message || 'error').slice(0, 80);

// ---- main ------------------------------------------------------------------

/**
 * Runs a measurement. `deps` overrides the side effects a test must not touch:
 * readKey, fetchImpl, fetchPosting, rows, canvasModule (pool), journalFactory, log.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? (line => console.log(line));
  let opts;
  try {
    opts = parseArgs(argv);
    if (!opts.dryRun) assertDurableOutDir(opts.out, { allowEphemeral: deps.allowEphemeral === true });
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const needsKey = !opts.dryRun && opts.arms.some(arm => arm !== 'app');
  let apiKey = '';
  if (needsKey) {
    apiKey = String(await (deps.readKey ?? readParallelKey)()).trim();
    if (!apiKey) {
      console.error('No Parallel API key in the Keychain item infinite-canvas-parallel-api-key; nothing was measured.');
      return 2;
    }
  }
  let canvasRows;
  try {
    canvasRows = deps.rows ?? await loadCanvasRows(opts.canvas, deps.canvasModule ?? {});
  } catch (error) {
    console.error(`Could not load the canvas: ${noUrls(error?.message || error)}`);
    return 2;
  }
  const eligible = eligiblePostingRows(canvasRows);
  const selected = seededShuffle(eligible, opts.seed).slice(0, opts.count);
  log(`canvas rows ${canvasRows.length} · eligible ${eligible.length} · selected ${selected.length} · arms ${opts.arms.join(',')}`);
  if (opts.dryRun) {
    log(`dry run: ${selected.length * opts.arms.length} reads would run; no network call was made`);
    return 0;
  }
  if (!selected.length) {
    console.error('No row has a confirmed https official posting URL with a title and company; nothing to measure.');
    return 1;
  }
  const pagesDir = prepareOutDir(opts.out);
  const resultsPath = path.join(opts.out, 'results.jsonl');
  fs.writeFileSync(resultsPath, '', { mode: 0o600 });
  const journal = deps.journalFactory
    ? deps.journalFactory({ tool: 'parallel-extract-ab', task: 'official posting page reading', label: opts.arms.join(','), outDir: opts.out, command: deps.command ?? '' })
    : createRunJournal({ tool: 'parallel-extract-ab', task: 'official posting page reading', label: opts.arms.join(','), outDir: opts.out,
      command: deps.command ?? '', facts: { canvas: path.basename(opts.canvas), count: opts.count, seed: opts.seed, concurrency: opts.concurrency, arms: opts.arms.join(',') } });
  const fetched = deps.fetchPosting ?? fetchOfficialPosting;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const records = [];
  const total = selected.length * opts.arms.length;
  try {
    await runPool(selected.flatMap(item => opts.arms.map(arm => ({ item, arm }))), opts.concurrency, async ({ item, arm }) => {
      const started = Date.now();
      let read;
      try {
        read = arm === 'app'
          ? await readAppArm(item.url, { fetchPosting: fetched })
          : await readParallelArm(arm, item.url, { fetchImpl, apiKey });
      } catch (error) {
        read = { ok: false, text: '', error: errorCodeOf(error), ms: Date.now() - started, acquiredAt: '' };
      }
      const text = String(read.text ?? '');
      fs.writeFileSync(path.join(pagesDir, pageFileName(item.url, arm)), text, { mode: 0o600 });
      const record = { arm, url: item.url, host: hostOf(item.url), ok: read.ok === true, chars: [...text].length,
        ms: Number.isFinite(read.ms) ? read.ms : Date.now() - started, acquiredAt: read.acquiredAt ?? '',
        error: read.ok === true ? '' : String(read.error || 'error').slice(0, 80),
        titleHit: titleHit(text, item.title), companyHit: companyHit(text, item.company),
        usable: false, closedSignal: closedSignal(text) };
      record.usable = classifyUsable({ ok: record.ok, chars: record.chars, titleHit: record.titleHit });
      records.push(record);
      fs.appendFileSync(resultsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      if (records.length % 10 === 0 || records.length === total) log(`completed ${records.length}/${total}`);
    });
  } catch (error) {
    journal.finish(`failed: ${errorCodeOf(error)}`);
    throw error;
  }
  const summary = { seed: opts.seed, count: opts.count, ...summarize(records, { arms: opts.arms }) };
  fs.writeFileSync(path.join(opts.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  log(`written: ${resultsPath} (pages and summary.json beside it)`);
  for (const arm of summary.arms) log(`${arm.arm}: n ${arm.n} · ok ${arm.ok} · usable ${arm.usable} · titleHit ${arm.titleHit} · median chars ${arm.medianChars} · median ms ${arm.medianMs} · closedSignal ${arm.closedSignal}`);
  for (const pair of summary.pairwise) log(`${pair.a} vs ${pair.b}: usable only in ${pair.a} ${pair.usableInANotB} · closedSignal differs ${pair.closedSignalDiffers}`);
  journal.update({ rows: summary.arms.map(arm => ({ arm: arm.arm, n: arm.n, valid: arm.usable, failed: arm.n - arm.ok,
    notes: `titleHit ${arm.titleHit}; median ${arm.medianChars} chars / ${arm.medianMs} ms; closedSignal ${arm.closedSignal}` })), facts: { selected: selected.length } });
  journal.finish('finished');
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2), { command: process.argv.slice(2).join(' ') })
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(noUrls(error?.message || error)); process.exitCode = 1; });
}
