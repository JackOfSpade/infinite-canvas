import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appSnapshotError, appSnapshotText, armRequestBody, canvasJobRows, classifyUsable, closedSignal, companyHit,
  main, pageFileName, parallelExtractBody, parseArgs, parseParallelExtract, readAppArm, readParallelArm,
  seededShuffle, selectPostingRows, summarize, titleHit,
} from './parallel-extract-ab.mjs';

const OUTSIDE = '/tmp/parallel-extract-ab-test-out';
const row = (index, overrides = {}) => ({
  title: `Senior Platform Engineer ${index}`,
  company: 'Acme Robotics',
  officialPosting: { outcome: 'found', sourceUrl: `https://jobs.example.com/postings/${index}` },
  ...overrides,
});

test('parseArgs fills defaults and a dry run needs only --canvas and --out', () => {
  const opts = parseArgs(['--canvas', 'canvas.json', '--out', OUTSIDE, '--dry-run']);
  assert.deepEqual(opts, { canvas: 'canvas.json', out: OUTSIDE, count: 40, seed: 1, concurrency: 4,
    arms: ['app', 'parallel-live', 'parallel-default'], dryRun: true });
  assert.deepEqual(parseArgs(['--canvas', 'c.json', '--out', OUTSIDE, '--count', '5', '--seed', '7',
    '--concurrency', '2', '--arms', 'parallel-live,app']).arms, ['parallel-live', 'app']);
});

test('parseArgs rejects unknown flags, unknown arms, bad numbers and an --out inside the repo', () => {
  assert.throws(() => parseArgs(['--bogus', 'x']), /Unknown argument --bogus/u);
  assert.throws(() => parseArgs(['--arms', 'app,tavily']), /Unknown arm tavily/u);
  assert.throws(() => parseArgs(['--count', '1.5']), /--count must be a whole number/u);
  assert.throws(() => parseArgs(['--concurrency', '0']), /--concurrency must be a whole number/u);
  assert.throws(() => parseArgs([]), /--canvas/u);
  assert.throws(() => parseArgs(['--canvas', 'c.json']), /--out/u);
  assert.throws(() => parseArgs(['--canvas', 'c.json', '--out', fileURLToPath(new URL('../scripts/out', import.meta.url))]), /outside the repo/u);
});

test('titleHit needs 60% of the title words of 3+ letters', () => {
  assert.equal(titleHit('We are hiring a Senior Platform Engineer in Leeds.', 'Senior Platform Engineer'), true);
  assert.equal(titleHit('We are hiring a Senior Platform Engineer in Leeds.', 'Senior Platform Designer'), true);
  assert.equal(titleHit('We are hiring a Senior Platform Engineer in Leeds.', 'Senior Platform Designer Architect'), false);
  assert.equal(titleHit('Nothing relevant here', 'QA Designer'), false);
  assert.equal(titleHit('engineer', 'QA Engineer'), true);
  assert.equal(titleHit('engineer', 'QA Designer'), false);
  assert.equal(titleHit('', 'Senior Engineer'), false);
  assert.equal(titleHit('Senior Engineer', ''), false);
});

test('companyHit uses the company name first significant word', () => {
  assert.equal(companyHit('At Acme Robotics we build things.', 'Acme Robotics'), true);
  assert.equal(companyHit('We build robots at Acme.', 'The Home Depot'), false);
  assert.equal(companyHit('About The Home Depot', 'The Home Depot'), true);
  assert.equal(companyHit('Acme is hiring', 'ACME'), true);
  assert.equal(companyHit('', 'Acme'), false);
});

test('closedSignal matches closure wording only', () => {
  assert.equal(closedSignal('This position has been filled.'), true);
  assert.equal(closedSignal('The job is no longer available.'), true);
  assert.equal(closedSignal('We are not accepting applications for this role.'), true);
  assert.equal(closedSignal('This job is closed.'), true);
  assert.equal(closedSignal('Apply now: this position is open and available.'), false);
  assert.equal(closedSignal(''), false);
});

test('classifyUsable gates on ok, 600 chars and titleHit', () => {
  assert.equal(classifyUsable({ ok: true, chars: 600, titleHit: true }), true);
  assert.equal(classifyUsable({ ok: true, chars: 599, titleHit: true }), false);
  assert.equal(classifyUsable({ ok: true, chars: 5000, titleHit: false }), false);
  assert.equal(classifyUsable({ ok: false, chars: 5000, titleHit: true }), false);
  assert.equal(classifyUsable({}), false);
});

test('summarize reports per-arm counts and medians and ordered pairwise differences', () => {
  const rows = [
    { arm: 'app', url: 'u1', ok: true, chars: 900, ms: 10, titleHit: true, usable: true, closedSignal: false },
    { arm: 'app', url: 'u2', ok: true, chars: 100, ms: 20, titleHit: false, usable: false, closedSignal: false },
    { arm: 'parallel-live', url: 'u1', ok: true, chars: 2000, ms: 300, titleHit: true, usable: true, closedSignal: true },
    { arm: 'parallel-live', url: 'u2', ok: true, chars: 1500, ms: 100, titleHit: true, usable: true, closedSignal: false },
    { arm: 'parallel-default', url: 'u1', ok: false, chars: 0, ms: 500, titleHit: false, usable: false, closedSignal: false },
  ];
  const summary = summarize(rows, { arms: ['app', 'parallel-live', 'parallel-default'] });
  assert.deepEqual(summary.arms[0], { arm: 'app', n: 2, ok: 2, usable: 1, titleHit: 1, medianChars: 500, medianMs: 15, closedSignal: 0 });
  assert.deepEqual(summary.arms[1], { arm: 'parallel-live', n: 2, ok: 2, usable: 2, titleHit: 2, medianChars: 1750, medianMs: 200, closedSignal: 1 });
  assert.deepEqual(summary.arms[2], { arm: 'parallel-default', n: 1, ok: 0, usable: 0, titleHit: 0, medianChars: 0, medianMs: 500, closedSignal: 0 });
  const pair = (a, b) => summary.pairwise.find(item => item.a === a && item.b === b);
  assert.deepEqual(pair('app', 'parallel-live'), { a: 'app', b: 'parallel-live', usableInANotB: 0, closedSignalDiffers: 1 });
  assert.deepEqual(pair('parallel-live', 'app'), { a: 'parallel-live', b: 'app', usableInANotB: 1, closedSignalDiffers: 1 });
  assert.equal(summary.pairwise.length, 6);
});

test('the live body carries fetch_policy and the default body leaves it out', () => {
  const url = 'https://jobs.example.com/posting/1';
  assert.deepEqual(parallelExtractBody(url, { fetchPolicy: true }), { urls: [url], objective: 'The full text of this job posting page.',
    advanced_settings: { full_content: true, fetch_policy: { max_age_seconds: 600 } } });
  assert.deepEqual(armRequestBody('parallel-default', url).advanced_settings, { full_content: true });
  assert.deepEqual(armRequestBody('parallel-live', url).advanced_settings.fetch_policy, { max_age_seconds: 600 });
  assert.throws(() => armRequestBody('app', url), /sends no Parallel request/u);
});

test('parseParallelExtract reads results, acquired_at, listed errors and empty content', () => {
  const url = 'https://jobs.example.com/posting/1';
  const payload = { results: [{ url, title: 'Engineer', excerpts: [], full_content: 'the page text', acquired_at: '2026-01-02T03:04:05Z' }], errors: [] };
  assert.deepEqual(parseParallelExtract(payload, url), { ok: true, fullContent: 'the page text', acquiredAt: '2026-01-02T03:04:05Z', title: 'Engineer' });
  const listed = parseParallelExtract({ ...payload, errors: [{ url, error_type: 'fetch_timeout' }] }, url);
  assert.equal(listed.ok, false);
  assert.equal(listed.error, 'parallel:fetch_timeout');
  const empty = parseParallelExtract({ results: [{ url, full_content: '   ', acquired_at: 'x' }], errors: [] }, url);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'empty-content');
  assert.equal(parseParallelExtract({ results: [{ url: 'https://other.example.com/', full_content: 'text' }], errors: [] }, url).error, 'invalid-response');
  assert.equal(parseParallelExtract(null, url).error, 'invalid-response');
});

test('readParallelArm sends the documented POST and treats a bad response as a failed read', async () => {
  const url = 'https://jobs.example.com/posting/1';
  const calls = [];
  const fetchImpl = async (target, options) => {
    calls.push({ target, options });
    return { ok: true, json: async () => ({ results: [{ url, title: 'Engineer', excerpts: [], full_content: 'page text', acquired_at: '2026-01-02T03:04:05Z' }], errors: [] }) };
  };
  const read = await readParallelArm('parallel-live', url, { fetchImpl, apiKey: 'test-key-not-real' });
  assert.equal(read.ok, true);
  assert.equal(read.text, 'page text');
  assert.equal(read.acquiredAt, '2026-01-02T03:04:05Z');
  assert.equal(calls[0].target, 'https://api.parallel.ai/v1/extract');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-api-key'], 'test-key-not-real');
  assert.deepEqual(JSON.parse(calls[0].options.body), armRequestBody('parallel-live', url));
  const refused = await readParallelArm('parallel-default', url, { fetchImpl: async () => ({ ok: false, status: 429,
    json: async () => ({ errors: [{ url, error_type: 'rate_limited' }] }) }), apiKey: 'k' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'parallel:rate_limited');
});

test('selectPostingRows keeps confirmed https postings with a title and company, deduped and seeded', () => {
  const rows = [
    row(1), row(1), row(2, { title: '' }), row(3, { officialPosting: { outcome: 'link-only', sourceUrl: 'https://jobs.example.com/3' } }),
    row(4, { officialPosting: { outcome: 'found', sourceUrl: 'http://jobs.example.com/4' } }), row(5, { company: '' }),
    row(6, { officialPosting: { outcome: 'found', officialApplyUrl: 'https://apply.example.com/6' } }),
  ];
  const picked = selectPostingRows(rows, { count: 10, seed: 3 });
  assert.deepEqual(picked.map(item => item.url).sort(), ['https://apply.example.com/6', 'https://jobs.example.com/postings/1']);
  assert.deepEqual(selectPostingRows(rows, { count: 1, seed: 3 }).length, 1);
  const many = Array.from({ length: 30 }, (_unused, index) => row(index));
  assert.deepEqual(selectPostingRows(many, { count: 30, seed: 9 }).map(item => item.url),
    selectPostingRows(many, { count: 30, seed: 9 }).map(item => item.url));
  assert.notDeepEqual(selectPostingRows(many, { count: 30, seed: 1 }).map(item => item.url),
    selectPostingRows(many, { count: 30, seed: 2 }).map(item => item.url));
  const numbers = Array.from({ length: 24 }, (_unused, index) => index);
  assert.deepEqual(seededShuffle(numbers, 5), seededShuffle(numbers, 5));
  assert.deepEqual([...seededShuffle(numbers, 5)].sort((a, b) => a - b), numbers);
  assert.notDeepEqual(seededShuffle(numbers, 5), seededShuffle(numbers, 6));
});

test('appSnapshotText prefers the matched description and appSnapshotError names why a page is unusable', () => {
  assert.equal(appSnapshotText({ read: true, description: 'matched description', pageText: 'page text' }), 'matched description');
  assert.equal(appSnapshotText({ read: true, pageText: 'page text' }), 'page text');
  assert.equal(appSnapshotText({ read: true }), '');
  assert.equal(appSnapshotError({ read: false, notFound: true }), 'not-found');
  assert.equal(appSnapshotError({ read: false, httpStatus: 403 }), 'http-403');
  assert.equal(appSnapshotError({ read: false }), 'unreadable');
  assert.equal(appSnapshotError({ read: true, description: 'text' }), '');
  assert.equal(appSnapshotError({ read: true }), 'empty-page');
});

test('readAppArm derives page text the way the snapshot code does and detects an empty shell', async () => {
  const url = 'https://jobs.example.com/postings/1';
  const prose = 'Acme Robotics builds robots. '.repeat(40);
  const page = async target => ({ url: target, body: `<html><body><main><h1>Senior Platform Engineer</h1><p>${prose}</p></main></body></html>`,
    contentType: 'text/html', statusCode: 200 });
  const read = await readAppArm(url, { fetchPosting: page });
  assert.equal(read.ok, true);
  assert.ok(read.text.length >= 600);
  assert.equal(titleHit(read.text, 'Senior Platform Engineer'), true);
  assert.equal(companyHit(read.text, 'Acme Robotics'), true);
  const shell = await readAppArm(url, { fetchPosting: async target => ({ url: target,
    body: '<html><body><div id="app"></div><script>window.__DATA__ = {}</script></body></html>', contentType: 'text/html', statusCode: 200 }) });
  assert.equal(shell.ok, false);
  assert.equal(shell.error, 'empty-page');
  const refused = await readAppArm(url, { fetchPosting: async () => { throw Object.assign(new Error('status 410'), { httpStatus: 410 }); } });
  assert.equal(refused.ok, false);
  assert.equal(refused.text, '');
  assert.ok(refused.error.length > 0);
});

test('pageFileName hides the URL and canvasJobRows finds rows anywhere in the canvas', () => {
  const name = pageFileName('https://jobs.example.com/postings/1', 'parallel-live');
  assert.match(name, /^[0-9a-f]{40}\.parallel-live\.txt$/u);
  assert.equal(name.includes('jobs.example.com'), false);
  const canvas = { children: [{ type: 'jobBoard', data: { rows: [row(1)] } }, { type: 'group',
    children: [{ data: { scoredJobs: [row(2)] } }, { data: { jobs: [row(3), row(1)] } }] }] };
  assert.equal(canvasJobRows(canvas).length, 4);
  const shared = row(7);
  assert.equal(canvasJobRows({ data: { rows: [shared], jobs: [shared] } }).length, 1);
});

test('main --dry-run selects rows, prints counts only and never reads the keychain or the network', async () => {
  const lines = [];
  const code = await main(['--canvas', 'private-canvas.json', '--out', OUTSIDE, '--dry-run', '--count', '2'], {
    rows: [row(1), row(2), row(3)],
    readKey: async () => { throw new Error('the keychain must not be read on a dry run'); },
    fetchImpl: async () => { throw new Error('the network must not be used on a dry run'); },
    log: line => lines.push(line),
  });
  assert.equal(code, 0);
  const printed = lines.join('\n');
  assert.match(printed, /canvas rows 3 · eligible 3 · selected 2/u);
  assert.match(printed, /no network call was made/u);
  assert.doesNotMatch(printed, /https:\/\//u);
  assert.doesNotMatch(printed, /jobs\.example\.com/u);
});

test('main exits with one clear line when the Parallel key is missing', async () => {
  const errors = [];
  const original = console.error;
  console.error = line => errors.push(String(line));
  let code;
  try {
    code = await main(['--canvas', 'private-canvas.json', '--out', OUTSIDE, '--arms', 'app,parallel-live'], {
      allowEphemeral: true, rows: [], readKey: async () => '', log: () => {},
    });
  } finally {
    console.error = original;
  }
  assert.equal(code, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No Parallel API key/u);
  assert.equal(errors[0].includes('\n'), false);
});
