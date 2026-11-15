import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pageFileName } from './parallel-extract-ab.mjs';
import {
  appendRecord, buildRecord, closedDetected, formatSummary, listedUnderErrors, loadCanvasRows, parseArgs, postingUrlForRow,
  prepareOutDir, readParallelPage, renderRead, scriptArgs, selectRenderRows, storedPostingUrls, summarizeRenderAb,
  writePage, writeSummary,
} from './parallel-render-ab.lib.mjs';

const OUTSIDE = '/tmp/parallel-render-ab-test-out';
const REPO_SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'out');
const row = (index, officialPosting = {}, overrides = {}) => ({
  title: `Senior Platform Engineer ${index}`, company: 'Acme Robotics',
  officialPosting: { outcome: 'found', sourceUrl: `https://jobs.example.com/postings/${index}`, ...officialPosting },
  ...overrides,
});

test('parseArgs fills defaults and a dry run needs only --canvas and --out', () => {
  assert.deepEqual(parseArgs(['--canvas', 'canvas.json', '--out', OUTSIDE, '--dry-run']),
    { canvas: 'canvas.json', out: OUTSIDE, closed: 20, open: 20, seed: 1, dryRun: true });
  assert.deepEqual(parseArgs(['--canvas', 'c.json', '--out', OUTSIDE, '--closed', '5', '--open', '7', '--seed', '3']),
    { canvas: 'c.json', out: OUTSIDE, closed: 5, open: 7, seed: 3, dryRun: false });
});

test('parseArgs rejects unknown flags, bad numbers and an --out inside the repo', () => {
  assert.throws(() => parseArgs(['--bogus', 'x']), /Unknown argument --bogus/u);
  assert.throws(() => parseArgs(['--canvas', 'c.json', '--out', OUTSIDE, '--closed', '1.5']), /--closed must be a whole number/u);
  assert.throws(() => parseArgs(['--canvas', 'c.json', '--out', OUTSIDE, '--seed', '-1']), /--seed must be a whole number/u);
  assert.throws(() => parseArgs(['--canvas', 'c.json', '--out', OUTSIDE, '--open']), /--open needs a value/u);
  assert.throws(() => parseArgs([]), /--canvas/u);
  assert.throws(() => parseArgs(['--canvas', 'c.json']), /--out/u);
  assert.throws(() => parseArgs(['--canvas', 'c.json', '--out', REPO_SCRIPTS]), /outside the repo/u);
});

test('scriptArgs takes only what follows the script path', () => {
  assert.deepEqual(scriptArgs(['/x/electron', '--inspect=9229', '/repo/scripts/parallel-render-ab.electron.mjs',
    '--canvas', 'c.json', '--dry-run']), ['--canvas', 'c.json', '--dry-run']);
  assert.deepEqual(scriptArgs(['/x/electron', '--canvas', 'c.json']), []);
});

test('storedPostingUrls keeps https stored URLs only, and postingUrlForRow falls back for closed rows', () => {
  const posting = { outcome: 'closed', sourceUrl: 'http://insecure.example.com/1',
    officialApplyUrl: 'https://apply.example.com/1', alternatives: [{ url: 'https://alt.example.com/1' }, { url: 'http://alt.example.com/2' }] };
  assert.deepEqual(storedPostingUrls(row(1, posting)), ['https://apply.example.com/1', 'https://alt.example.com/1']);
  assert.equal(postingUrlForRow(row(1, posting), 'closed'), 'https://apply.example.com/1');
  assert.equal(postingUrlForRow(row(2, { outcome: 'found', sourceUrl: 'http://insecure.example.com/2' }), 'open'), '');
  assert.equal(postingUrlForRow(row(3, { outcome: 'closed', sourceUrl: 'http://insecure.example.com/3',
    officialApplyUrl: 'https://apply.example.com/3' }), 'closed'), 'https://apply.example.com/3');
});

test('selectRenderRows splits closed from confirmed-open rows and dedupes by URL across both', () => {
  const rows = [
    row(1), row(2), row(3, { outcome: 'closed' }), row(4, { outcome: 'closed', sourceUrl: 'https://jobs.example.com/postings/1' }),
    row(5, {}, { title: '' }), row(6, {}, { company: '  ' }), row(7, { outcome: 'ambiguous' }),
    row(8, { outcome: 'closed', sourceUrl: 'http://insecure.example.com/8' }), row(9),
  ];
  const selected = selectRenderRows(rows, { closed: 10, open: 10, seed: 1 });
  // The closed row owns postings/1, and the duplicate closed row is deduped by URL: closed 2, open 2.
  assert.deepEqual(selected.eligible, { closed: 2, open: 2 });
  assert.deepEqual(selected.closed.map(item => item.url).sort(), ['https://jobs.example.com/postings/1',
    'https://jobs.example.com/postings/3']);
  assert.deepEqual(selected.open.map(item => item.url).sort(), ['https://jobs.example.com/postings/2',
    'https://jobs.example.com/postings/9']);
  assert.deepEqual(selected.open.map(item => item.group), ['open', 'open']);
  assert.deepEqual(selected.open.map(item => item.title).sort(), ['Senior Platform Engineer 2', 'Senior Platform Engineer 9']);
});

test('selectRenderRows shuffles each group with the seed and takes --closed / --open', () => {
  const rows = [...Array.from({ length: 12 }, (_, index) => row(index + 1)),
    ...Array.from({ length: 8 }, (_, index) => row(101 + index, { outcome: 'closed' }))];
  const first = selectRenderRows(rows, { closed: 3, open: 4, seed: 7 });
  const again = selectRenderRows(rows, { closed: 3, open: 4, seed: 7 });
  const other = selectRenderRows(rows, { closed: 3, open: 4, seed: 8 });
  assert.deepEqual(first, again);
  // The seeded picks, not the canvas order: seed 7 takes these rows.
  assert.deepEqual(first.closed.map(item => item.url), ['https://jobs.example.com/postings/105',
    'https://jobs.example.com/postings/107', 'https://jobs.example.com/postings/102']);
  assert.deepEqual(first.open.map(item => item.url), ['https://jobs.example.com/postings/8', 'https://jobs.example.com/postings/11',
    'https://jobs.example.com/postings/4', 'https://jobs.example.com/postings/6']);
  assert.deepEqual(other.closed.map(item => item.url), ['https://jobs.example.com/postings/101',
    'https://jobs.example.com/postings/107', 'https://jobs.example.com/postings/106']);
  assert.notDeepEqual(first.open.map(item => item.url), other.open.map(item => item.url));
  assert.deepEqual(selectRenderRows(rows, { closed: 0, open: 0, seed: 7 }).open, []);
});

test('closedDetected reads a closure sentence, a missing page or a short page that never names the job', () => {
  assert.equal(closedDetected({ ok: true, chars: 900, titleHit: true, closedSignal: true, notFound: false }), true);
  assert.equal(closedDetected({ ok: true, chars: 900, titleHit: true, closedSignal: false, notFound: true }), true);
  assert.equal(closedDetected({ ok: true, chars: 120, titleHit: false, closedSignal: false, notFound: false }), true);
  assert.equal(closedDetected({ ok: true, chars: 120, titleHit: true, closedSignal: false, notFound: false }), false);
  assert.equal(closedDetected({ ok: true, chars: 400, titleHit: false, closedSignal: false, notFound: false }), false);
  assert.equal(closedDetected({ ok: false, chars: 0, titleHit: false, closedSignal: false, notFound: false }), false);
  assert.equal(closedDetected(), false);
});

test('renderRead maps the render result shape', () => {
  assert.deepEqual(renderRead({ ok: true, status: 404, settled: true, text: '' }), { ok: true, text: '', error: '',
    httpStatus: 404, settled: true, notFound: true, acquiredAt: '', ms: 0 });
  assert.deepEqual(renderRead({ ok: false, reason: 'blocked' }, 12), { ok: false, text: '', error: 'blocked',
    httpStatus: null, settled: false, notFound: false, acquiredAt: '', ms: 12 });
  assert.equal(renderRead(null).error, 'invalid-result');
});

const longPostingText = `Senior Platform Engineer, Acme Robotics. ${'Apply on our careers site today. '.repeat(30)}`;

test('buildRecord fills every results.jsonl field for the render reader', () => {
  const record = buildRecord({ url: 'https://jobs.example.com/postings/7', group: 'open', reader: 'render',
    title: 'Senior Platform Engineer', company: 'Acme Robotics',
    read: { ok: true, text: longPostingText, httpStatus: 200, settled: true, ms: 4321 } });
  assert.deepEqual(record, { url: 'https://jobs.example.com/postings/7', group: 'open', host: 'jobs.example.com', reader: 'render',
    ok: true, error: '', httpStatus: 200, settled: true, chars: [...longPostingText].length, ms: 4321,
    titleHit: true, companyHit: true, closedSignal: false, notFound: false, acquiredAt: '', usable: true, closedDetected: false });
  const gone = buildRecord({ url: 'https://jobs.example.com/postings/8', group: 'closed', reader: 'render',
    title: 'Senior Platform Engineer', company: 'Acme Robotics', read: { ok: true, text: '', httpStatus: 410, settled: true, ms: 90 } });
  assert.equal(gone.chars, 0);
  assert.equal(gone.notFound, true);
  assert.equal(gone.usable, false);
  assert.equal(gone.closedDetected, true);
});

test('buildRecord keeps httpStatus and settled for the render reader only', () => {
  const record = buildRecord({ url: 'https://jobs.example.com/postings/9', group: 'closed', reader: 'parallel',
    title: 'Senior Platform Engineer', company: 'Acme Robotics',
    read: { ok: false, text: '', error: 'parallel:fetch_error', httpStatus: 200, settled: true, notFound: true, acquiredAt: '2026-01-02T03:04:05Z', ms: 700 } });
  assert.equal(record.httpStatus, null);
  assert.equal(record.settled, null);
  assert.equal(record.acquiredAt, '2026-01-02T03:04:05Z');
  assert.equal(record.error, 'parallel:fetch_error');
  assert.equal(record.closedDetected, true);
  const short = buildRecord({ url: 'https://jobs.example.com/postings/10', group: 'closed', reader: 'parallel',
    title: 'Senior Platform Engineer', company: 'Acme Robotics', read: { ok: true, text: 'Gone.', ms: 5 } });
  assert.equal(short.chars, 5);
  assert.equal(short.closedDetected, true);
  assert.equal(short.acquiredAt, '');
});

const fakeFetch = (payload, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (endpoint, init) => {
    calls.push({ endpoint, init });
    return { ok, status, json: async () => payload };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

test('readParallelPage sends the live extract body and maps a result', async () => {
  const fetchImpl = fakeFetch({ results: [{ url: 'https://jobs.example.com/postings/1/', title: 'Senior Platform Engineer',
    full_content: longPostingText, acquired_at: '2026-01-02T03:04:05Z' }] });
  const read = await readParallelPage('https://jobs.example.com/postings/1', { fetchImpl, apiKey: 'test-key' });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].endpoint, 'https://api.parallel.ai/v1/extract');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].init.headers['x-api-key'], 'test-key');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { urls: ['https://jobs.example.com/postings/1'],
    objective: 'The full text of this job posting page.',
    advanced_settings: { full_content: true, fetch_policy: { max_age_seconds: 600 } } });
  assert.deepEqual({ ...read, ms: 0 }, { ok: true, text: longPostingText, error: '', httpStatus: null, settled: false, notFound: false,
    acquiredAt: '2026-01-02T03:04:05Z', ms: 0 });
  assert.ok(Number.isFinite(read.ms) && read.ms >= 0);
});

test('readParallelPage treats a URL listed under errors as not found and a rejection as a failure', async () => {
  const listed = await readParallelPage('https://jobs.example.com/postings/2',
    { fetchImpl: fakeFetch({ results: [], errors: [{ url: 'https://jobs.example.com/postings/2', error_type: 'fetch_error' }] }) });
  assert.equal(listed.ok, false);
  assert.equal(listed.notFound, true);
  assert.equal(listed.error, 'parallel:fetch_error');
  const rejected = await readParallelPage('https://jobs.example.com/postings/3',
    { fetchImpl: fakeFetch({ errors: [{ url: 'https://jobs.example.com/postings/3', error_type: 'invalid_url' }] }, { ok: false, status: 422 }) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.notFound, true);
  assert.equal(rejected.error, 'parallel:invalid_url');
  const empty = await readParallelPage('https://jobs.example.com/postings/4',
    { fetchImpl: fakeFetch({ results: [{ url: 'https://jobs.example.com/postings/4', full_content: '   ' }] }) });
  assert.equal(empty.ok, false);
  assert.equal(empty.notFound, false);
  assert.equal(empty.error, 'empty-content');
  const other = await readParallelPage('https://jobs.example.com/postings/5',
    { fetchImpl: fakeFetch({ results: [{ url: 'https://jobs.example.com/postings/999', full_content: 'x' }] }) });
  assert.equal(other.error, 'invalid-response');
  assert.equal(other.notFound, false);
  assert.equal(listedUnderErrors({ errors: [{ url: 'https://jobs.example.com/postings/2' }] }, 'https://jobs.example.com/postings/2/'), true);
  assert.equal(listedUnderErrors(null, 'https://jobs.example.com/postings/2'), false);
});

const summaryRecord = (group, reader, url, { ok = true, usable = false, closedDetected = false, chars = 0, ms = 0 } = {}) =>
  ({ group, reader, url, ok, usable, closedDetected, chars, ms });

const summaryFixture = [
  summaryRecord('closed', 'render', 'https://jobs.example.com/c1', { usable: true, closedDetected: true, chars: 700, ms: 1000 }),
  summaryRecord('closed', 'render', 'https://jobs.example.com/c2', { usable: true, chars: 900, ms: 3000 }),
  summaryRecord('closed', 'parallel', 'https://jobs.example.com/c1', { closedDetected: true, chars: 500, ms: 200 }),
  summaryRecord('closed', 'parallel', 'https://jobs.example.com/c2', { usable: true, chars: 1200, ms: 400 }),
  summaryRecord('open', 'render', 'https://jobs.example.com/o1', { usable: true, chars: 800, ms: 1500 }),
  summaryRecord('open', 'parallel', 'https://jobs.example.com/o1', { ok: false, closedDetected: true, chars: 300, ms: 100 }),
];

test('summarizeRenderAb counts per group and reader with medians', () => {
  const summary = summarizeRenderAb(summaryFixture);
  assert.deepEqual(summary.table, [
    { group: 'closed', reader: 'render', n: 2, ok: 2, usable: 2, closedDetected: 1, medianChars: 800, medianMs: 2000 },
    { group: 'closed', reader: 'parallel', n: 2, ok: 2, usable: 1, closedDetected: 1, medianChars: 850, medianMs: 300 },
    { group: 'open', reader: 'render', n: 1, ok: 1, usable: 1, closedDetected: 0, medianChars: 800, medianMs: 1500 },
    { group: 'open', reader: 'parallel', n: 1, ok: 0, usable: 0, closedDetected: 1, medianChars: 300, medianMs: 100 },
  ]);
});

test('summarizeRenderAb pairs the readers per group: closure 2x2 and single-reader usable URLs', () => {
  const summary = summarizeRenderAb(summaryFixture);
  assert.deepEqual(summary.agreement, [
    { group: 'closed', urls: 2, both: 1, renderOnly: 0, parallelOnly: 0, neither: 1, usableRenderOnly: 1, usableParallelOnly: 0 },
    { group: 'open', urls: 1, both: 0, renderOnly: 0, parallelOnly: 1, neither: 0, usableRenderOnly: 1, usableParallelOnly: 0 },
  ]);
  const empty = summarizeRenderAb([]);
  assert.deepEqual(empty.table.map(cell => [cell.group, cell.reader, cell.n, cell.ok, cell.usable, cell.closedDetected,
    cell.medianChars, cell.medianMs]), [['closed', 'render', 0, 0, 0, 0, 0, 0], ['closed', 'parallel', 0, 0, 0, 0, 0, 0],
    ['open', 'render', 0, 0, 0, 0, 0, 0], ['open', 'parallel', 0, 0, 0, 0, 0, 0]]);
  assert.deepEqual(empty.agreement.map(counts => [counts.group, counts.urls, counts.both, counts.renderOnly,
    counts.parallelOnly, counts.neither, counts.usableRenderOnly, counts.usableParallelOnly]),
  [['closed', 0, 0, 0, 0, 0, 0, 0], ['open', 0, 0, 0, 0, 0, 0, 0]]);
});

test('formatSummary prints the table and the per-group counts only', () => {
  assert.deepEqual(formatSummary(summarizeRenderAb(summaryFixture)), [
    ['group', 'reader', 'n', 'ok', 'usable', 'closedDetected', 'medianChars', 'medianMs'].join('\t'),
    ['closed', 'render', 2, 2, 2, 1, 800, 2000].join('\t'),
    ['closed', 'parallel', 2, 2, 1, 1, 850, 300].join('\t'),
    ['open', 'render', 1, 1, 1, 0, 800, 1500].join('\t'),
    ['open', 'parallel', 1, 0, 0, 1, 300, 100].join('\t'),
    'closed: urls 2 · closed both 1 · render only 0 · parallel only 0 · neither 1 · usable render only 1 · parallel only 0',
    'open: urls 1 · closed both 0 · render only 0 · parallel only 1 · neither 0 · usable render only 1 · parallel only 0',
  ]);
});

test('prepareOutDir, writePage, appendRecord and writeSummary write private files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-render-ab-test-'));
  try {
    const out = path.join(root, 'run');
    const { pagesDir, resultsPath } = prepareOutDir(out);
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    assert.equal(fs.statSync(pagesDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(resultsPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(resultsPath, 'utf8'), '');
    const url = 'https://jobs.example.com/postings/42';
    const file = writePage(pagesDir, url, 'render', 'page text');
    assert.equal(path.basename(file), pageFileName(url, 'render'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'page text');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const record = { url, group: 'open', reader: 'render', ok: true };
    appendRecord(resultsPath, record);
    appendRecord(resultsPath, { ...record, reader: 'parallel' });
    assert.deepEqual(fs.readFileSync(resultsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
      [record, { ...record, reader: 'parallel' }]);
    const summaryPath = writeSummary(out, { table: [], agreement: [] }, { seed: 3 });
    assert.deepEqual(JSON.parse(fs.readFileSync(summaryPath, 'utf8')), { seed: 3, table: [], agreement: [] });
    assert.equal(fs.statSync(summaryPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadCanvasRows parses the canvas through the workspace pool and returns its job rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-render-ab-canvas-'));
  try {
    const canvasPath = path.join(root, 'canvas.json');
    fs.writeFileSync(canvasPath, '{"enc":"canvas"}');
    const seen = [];
    const pool = {
      parseWorkspaceText: (text) => { seen.push(text); return { encoded: text }; },
      restoreWorkspaceContent: parsed => ({ scoredJobs: [{ title: 'Restored' }], encoded: parsed.encoded }),
    };
    assert.deepEqual((await loadCanvasRows(canvasPath, { pool })).map(row => row.title), ['Restored']);
    assert.deepEqual(seen, ['{"enc":"canvas"}']);
    const unrestored = { parseWorkspaceText: text => ({ scoredJobs: [{ title: text }] }), restoreWorkspaceContent: () => null };
    assert.deepEqual((await loadCanvasRows(canvasPath, { pool: unrestored })).map(row => row.title), ['{"enc":"canvas"}']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
