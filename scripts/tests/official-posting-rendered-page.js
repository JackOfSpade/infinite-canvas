import assert from 'node:assert/strict';
import { snapshotOfficialPostingLeads, SNAPSHOT_TOTAL_CHARS, trimOfficialPostingSnapshots } from '../../electron/ipc/officialPostingSnapshot.js';
import { _resetOfficialPostingRenderForTests, createOfficialPostingRenderSession, publicHostCheck, renderOfficialPostingPage,
  waitForPageToSettle } from '../../electron/ipc/officialPostingRenderedPage.js';
import { decideOfficialPostingJudgments, buildOfficialPostingJudgeRequest } from '../../electron/ipc/officialPostingJudge.js';
import { officialPostingComparativeTrail, officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';
import { unresolvedOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';
import { buildListingLivenessRequest, validateListingLivenessResponse } from '../../electron/ipc/listingLivenessAi.js';
import { resolveOfficialPostings } from '../../electron/ipc/officialPostingService.js';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const URL_A = 'https://careers.northwind.test/job/42';
const VISIBLE = `Dispatch Engineer\nApply now\n${'Build routing services for regional delivery teams. '.repeat(10)}`;
const lead = (extra = {}) => ({ id: 'P1', url: URL_A, kind: 'posting', ...extra });
const shell = async url => ({ url, contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
const shown = (extra = {}) => ({ ok: true, status: 200, finalUrl: URL_A, settled: true, title: 'Dispatch Engineer',
  text: VISIBLE, html: `<html><body><main>${VISIBLE}</main></body></html>`, ...extra });
const seq = values => { let at = 0; return () => values[Math.min(at++, values.length - 1)]; };
// A download the site refused, and one the site answered not found. Both leave the lead unread.
const blocked = async () => { throw Object.assign(new Error('HTTP 403'), { statusCode: 403 }); };
const gone = async () => { throw Object.assign(new Error('HTTP 404'), { statusCode: 404 }); };
const READER_TEXT = 'Dispatch Engineer\nApply now';

// The resolveOfficialPostings harness, for the reader the service picks for itself.
const DESCRIPTION = 'Northwind Labs is hiring a Dispatch Engineer to build reliable routing services for regional delivery teams.\n'
  + '• Design the dispatch scheduling service and its reporting pipeline.\n'
  + '• Review route reports with operations leads every week.\n'
  + 'Requirements: five years building backend services in TypeScript or Go.';
const job = () => ({ title: 'Dispatch Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: DESCRIPTION, url: 'https://www.linkedin.com/jobs/view/synthetic-dispatch', sourceJobKey: 'dispatch-1' });
const POSTING = 'https://job-boards.greenhouse.io/northwind/jobs/4455667';
const CAREERS = 'https://northwind.test/careers';
const research = ids => ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nCANDIDATE: ${JSON.stringify({ careersPageUrl: CAREERS,
  postingUrl: POSTING, employer: 'Northwind Labs', employerDomain: 'https://northwind.test', ats: 'Greenhouse' })}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
const requestedIds = prompt => prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
const hostLeads = prompt => JSON.parse(prompt.split('BEGIN HOST LEADS JSON\n')[1].split('\nEND HOST LEADS JSON')[0]);
const uncertainAnswer = { choice: 'uncertain', postingUrl: '', status: 'unknown', statusQuote: '', employerLinked: false, employerPageUrl: '',
  employerLinkQuote: '', title: '', employer: '', location: '', salary: '', description: '', evidence: [],
  conflicts: ['The site blocked the download, so the page text cannot settle this lead.'] };
const challenge = async () => { throw Object.assign(new Error('HTTP 202'), { statusCode: 202 }); };
async function withStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-reader-'));
  try { return await run(createOfficialPostingStore(path.join(root, 'official-postings'))); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
// Runs a lookup against a site that challenges every download, and returns what the judges saw.
async function challengedLookup(readPage) {
  return withStore(async store => {
    const callRaw = async prompt => research(requestedIds(prompt));
    const callMatch = async prompt => { hostLeads(prompt); return JSON.stringify(uncertainAnswer); };
    await resolveOfficialPostings([job()], { store, snapshotFetch: challenge, readPage, bypassCache: true, callRaw, callMatch });
    const log = await fs.readFile(path.join(store.rootDir, 'judgments.jsonl'), 'utf8').catch(() => '');
    return log.split('\n').filter(Boolean).map(line => JSON.parse(line));
  });
}

// A browser that records what the page tried to do, driven by the routes the test gives it.
function fakeBrowser({ requests = [], goto, seen = { title: 'T', text: VISIBLE, html: `<p>${VISIBLE}</p>` }, status = 200, finalUrl = URL_A } = {}) {
  const log = { contexts: 0, closed: 0, handled: [], blocked: [] };
  const handlers = {};
  const frame = {};
  const page = {
    on(name, fn) { handlers[name] = fn; },
    evaluateOnNewDocument: async () => {}, setExtraHTTPHeaders: async () => {}, setBypassServiceWorker: async () => {}, setRequestInterception: async () => {},
    createCDPSession: async () => ({ send: async (method, params) => { if (method === 'Network.setBlockedURLs') log.blocked = params.urls; } }),
    mainFrame: () => frame, url: () => finalUrl,
    async goto() {
      for (const item of requests) {
        await new Promise(resolve => {
          const finish = verdict => { log.handled.push([item.url, verdict]); resolve(); };
          handlers.request({ url: () => item.url, resourceType: () => item.type || 'xhr', isNavigationRequest: () => !!item.navigation, frame: () => frame,
            abort: async () => finish('abort'), continue: async () => { finish('continue'); handlers.requestfinished?.(item); } });
        });
      }
      if (goto) return goto();
      return { status: () => status };
    },
    evaluate: async (fn, arg) => (arg ? seen : seen.text.length),
  };
  const browser = { createBrowserContext: async () => { log.contexts += 1; return { newPage: async () => page, close: async () => { log.closed += 1; } }; } };
  return { browser, log };
}
const open = (fake, options = {}) => renderOfficialPostingPage(URL_A, { getBrowser: async () => fake.browser,
  isPublicUrl: async url => !/internal/u.test(url), withLock: fn => fn(), ...options });

export default [
  {
    name: 'A page empty to a plain download is replaced by what the browser showed',
    async run() {
      const asked = [];
      const [snap] = await snapshotOfficialPostingLeads([lead()], { fetch: shell, render: async url => { asked.push(url); return shown(); } });
      assert.deepEqual(asked, [URL_A]);
      assert.equal(snap.rendered, true);
      assert.equal(snap.read, true);
      assert.match(snap.pageText, /Apply now/u);
      assert.equal(snap.renderFailed, undefined);
    },
  },
  {
    name: 'A posting the plain download already read is still opened, and keeps both its data and the page exactly as shown; a careers page with board links is not',
    async run() {
      const posting = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Dispatch Engineer', url: URL_A,
        hiringOrganization: { name: 'Northwind' }, description: `<p>${'Build routing services for delivery teams. '.repeat(20)}</p>` };
      const full = async url => ({ url, contentType: 'text/html', body: `<html><script type="application/ld+json">${JSON.stringify(posting)}</script></html>` });
      const asked = [];
      const [read] = await snapshotOfficialPostingLeads([lead()], { fetch: full, render: async url => { asked.push(url); return shown(); } });
      assert.deepEqual(asked, [URL_A], 'good structured data does not excuse a posting from being opened');
      assert.equal(read.rendered, true);
      assert.equal(read.title, 'Dispatch Engineer', 'the structured data is kept');
      assert.ok(read.description.includes('Build routing services'), 'the description is kept');
      assert.equal(read.pageText, VISIBLE, 'the page text is what the browser showed, unedited');
      const gone = async () => { throw Object.assign(new Error('gone'), { code: 'closed', statusCode: 404 }); };
      const [missing] = await snapshotOfficialPostingLeads([lead()], { fetch: gone, render: async () => ({ ok: false, reason: 'blocked' }) });
      assert.equal(missing.notFound, true);
      const never = async () => { throw new Error('must not open'); };
      const links = async url => ({ url, contentType: 'text/html', body: '<a href="https://job-boards.greenhouse.io/northwind">Open roles</a>' });
      const [careers] = await snapshotOfficialPostingLeads([lead({ kind: 'careers', url: 'https://northwind.test/careers' })], { fetch: links, render: never });
      assert.ok(careers.jobBoardLinks.length);
      assert.equal(careers.renderFailed, undefined, 'a careers lead that already led to a board is not opened');
    },
  },
  {
    name: 'A rendered page is kept whole: text beyond the old 30000 characters survives, with its end',
    async run() {
      const long = `${'Build routing services for delivery teams. '.repeat(1_200)}FINAL-SENTENCE-OF-THE-PAGE`;
      assert.ok(long.length > 40_000);
      const [snap] = await snapshotOfficialPostingLeads([lead()], { fetch: shell, render: async () => shown({ text: long, html: `<main>${long}</main>` }) });
      assert.equal(snap.rendered, true);
      assert.equal(snap.pageText, long);
      assert.ok(snap.pageText.endsWith('FINAL-SENTENCE-OF-THE-PAGE'));
      assert.equal(snap.pageTextTruncated, undefined);
    },
  },
  {
    name: 'A download a site refused still gets a browser attempt; a board that lists nothing gets one too',
    async run() {
      const refused = async () => { throw Object.assign(new Error('no'), { code: 'fetch-failed', statusCode: 403 }); };
      const [snap] = await snapshotOfficialPostingLeads([lead()], { fetch: refused, render: async () => shown() });
      assert.equal(snap.rendered, true);
      assert.equal(snap.httpStatus, undefined);
    },
  },
  {
    name: 'A failed or nearly empty browser attempt keeps the plain snapshot and says why, and closes nothing by itself',
    async run() {
      for (const [render, code] of [[async () => ({ ok: false, reason: 'blocked' }), 'blocked'], [async () => shown({ settled: false, text: 'Loading', html: '<p>Loading</p>' }), 'empty'],
        [async () => shown({ text: '  ', html: '<p></p>' }), 'empty'],
        [async () => { throw new Error('boom'); }, 'load-failed']]) {
        const [snap] = await snapshotOfficialPostingLeads([lead()], { fetch: shell, render });
        assert.equal(snap.renderFailed, code);
        assert.equal(snap.rendered, undefined);
        assert.equal(snap.notFound, undefined);
        assert.equal(snap.listedInBoardData, undefined);
      }
    },
  },
  {
    name: 'A browser 404 is the same answer as a plain 404; a slow page is marked so missing text proves nothing',
    async run() {
      const [gone] = await snapshotOfficialPostingLeads([lead()], { fetch: shell, render: async () => shown({ status: 404, text: '', html: '' }) });
      assert.equal(gone.notFound, true);
      assert.equal(gone.read, false);
      const [slow] = await snapshotOfficialPostingLeads([lead()], { fetch: shell, render: async () => shown({ settled: false }) });
      assert.equal(slow.settled, false);
    },
  },
  {
    name: 'A short page that finished loading is still evidence',
    async run() {
      const [snap] = await snapshotOfficialPostingLeads([lead()], { fetch: shell,
        render: async () => shown({ text: 'This job is no longer available.', html: '<p>This job is no longer available.</p>' }) });
      assert.equal(snap.rendered, true);
      assert.equal(snap.pageText, 'This job is no longer available.');
    },
  },
  {
    name: 'Every posting lead opens with no cap; a careers lead opens only when the download found no board link',
    async run() {
      const bare = lead({ id: 'P1', kind: 'careers', url: 'https://a.test/careers' });
      const linked = lead({ id: 'P2', kind: 'careers', url: 'https://b.test/careers' });
      const postings = [3, 4, 5, 6, 7, 8].map(n => lead({ id: `P${n}`, url: `https://a.test/job/${n}` }));
      const fetchLeads = async url => (url === linked.url
        ? { url, contentType: 'text/html', body: '<a href="https://job-boards.greenhouse.io/northwind">Open roles</a>' }
        : { url, contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
      const asked = [];
      const snaps = await snapshotOfficialPostingLeads([bare, linked, ...postings], { fetch: fetchLeads, render: async url => { asked.push(url); return shown({ finalUrl: url }); } });
      assert.deepEqual([...asked].sort(), [bare.url, ...postings.map(item => item.url)].sort());
      assert.ok(postings.every(item => asked.includes(item.url)), 'six posting leads, all opened');
      assert.ok(!asked.includes(linked.url), 'a careers page with board links is not opened');
      assert.ok(snaps.every(snap => snap.renderFailed !== 'not-attempted'));
      assert.equal(snaps[1].rendered, undefined);
    },
  },
  {
    name: 'A careers page whose job board link appears only after JavaScript now shows that board',
    async run() {
      const url = 'https://northwind.test/careers';
      const [snap] = await snapshotOfficialPostingLeads([lead({ kind: 'careers', url })], { fetch: shell,
        render: async () => shown({ finalUrl: url, text: 'Open roles', html: '<a href="https://job-boards.greenhouse.io/northwind">Open roles</a>' }) });
      assert.equal(snap.rendered, true);
      assert.deepEqual(snap.jobBoardLinks, ['https://job-boards.greenhouse.io/northwind']);
    },
  },
  {
    name: 'The browser session is throwaway, blocks non-public requests and sockets, and always closes',
    async run() {
      const fake = fakeBrowser({ requests: [{ url: 'https://api.northwind.test/jobs' }, { url: 'https://internal.test/admin' },
        { url: 'https://cdn.northwind.test/a.png', type: 'image' }] });
      const result = await open(fake);
      assert.equal(result.ok, true);
      assert.equal(result.settled, true);
      assert.deepEqual(fake.log.handled.map(([, verdict]) => verdict), ['continue', 'abort', 'abort']);
      assert.deepEqual(fake.log.blocked, ['ws://*', 'wss://*']);
      assert.deepEqual([fake.log.contexts, fake.log.closed], [1, 1]);
      const failing = fakeBrowser({ goto: () => { throw new Error('net::ERR_FAILED'); } });
      assert.deepEqual(await open(failing), { ok: false, reason: 'load-failed' });
      assert.equal(failing.log.closed, 1);
    },
  },
  {
    name: 'A redirect to a non-public address fails as unsafe, and the first address is checked before any browser opens',
    async run() {
      const redirected = fakeBrowser({ requests: [{ url: 'https://internal.test/', navigation: true, type: 'document' }],
        goto: () => { throw new Error('net::ERR_BLOCKED_BY_CLIENT'); } });
      assert.deepEqual(await open(redirected), { ok: false, reason: 'unsafe-address' });
      let opened = false;
      const result = await renderOfficialPostingPage('https://internal.test/job', { isPublicUrl: async () => false, withLock: fn => fn(),
        getBrowser: async () => { opened = true; throw new Error('no'); } });
      assert.deepEqual(result, { ok: false, reason: 'unsafe-address' });
      assert.equal(opened, false);
      assert.deepEqual(await renderOfficialPostingPage('http://northwind.test/job'), { ok: false, reason: 'unsafe-address' });
    },
  },
  {
    name: 'A page that a non-public address answered returns nothing, and it cannot start unguarded workers',
    async run() {
      _resetOfficialPostingRenderForTests();
      const fake = fakeBrowser();
      const page = await (await fake.browser.createBrowserContext()).newPage();
      const before = [];
      page.evaluateOnNewDocument = async fn => { before.push(String(fn)); };
      const realGoto = page.goto;
      let respond;
      const wrapped = { ...page, on(name, fn) { if (name === 'response') respond = fn; page.on(name, fn); },
        goto: async () => { respond({ remoteAddress: () => ({ ip: '10.0.0.8' }) }); return realGoto(); } };
      const browser = { createBrowserContext: async () => ({ newPage: async () => wrapped, close: async () => {} }) };
      assert.deepEqual(await open({ browser }), { ok: false, reason: 'unsafe-address' });
      assert.match(before[0], /SharedWorker/u);
      assert.match(before[0], /serviceWorker/u);
    },
  },
  {
    name: 'Pages wait their turn, so a lookup\'s own queue never reads as the browser being busy, and a late session still closes',
    async run() {
      _resetOfficialPostingRenderForTests();
      let running = 0; let most = 0;
      const withLock = async fn => { running += 1; most = Math.max(most, running); await new Promise(resolve => setImmediate(resolve)); const value = await fn(); running -= 1; return value; };
      const results = await Promise.all([1, 2, 3, 4].map(() => open(fakeBrowser(), { withLock })));
      assert.ok(results.every(result => result.ok));
      assert.equal(most, 1);
      _resetOfficialPostingRenderForTests();
      let lateClosed = 0; let arrive;
      const late = { createBrowserContext: () => new Promise(resolve => { arrive = () => resolve({ close: async () => { lateClosed += 1; } }); }) };
      const cancel = new AbortController();
      const pending = open({ browser: late }, { signal: cancel.signal });
      await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      cancel.abort();
      assert.deepEqual(await pending, { ok: false, reason: 'aborted' });
      arrive();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(lateClosed, 1);
      _resetOfficialPostingRenderForTests();
    },
  },
  {
    name: 'The address rule matches the plain download and fails closed',
    async run() {
      const check = publicHostCheck({ lookup: async host => { if (host === 'broken.test') throw new Error('dns');
        return [{ address: host === 'rebind.test' ? '10.0.0.8' : '93.184.216.34' }]; } });
      assert.equal(await check('https://example.test/a'), true);
      assert.equal(await check('https://rebind.test/a'), false);
      assert.equal(await check('https://broken.test/a'), false);
      assert.equal(await check('https://127.0.0.1/a'), false);
      assert.equal(await check('https://[::1]/a'), false);
      assert.equal(await check('http://example.test/a'), false);
      assert.equal(await check('file:///etc/hosts'), false);
      assert.equal(await check('data:text/plain,hi'), true);
    },
  },
  {
    name: 'A wedged browser or a held browser lock gives a failure, and a held lock pauses further waiting',
    async run() {
      _resetOfficialPostingRenderForTests();
      const unavailable = await renderOfficialPostingPage(URL_A, { isPublicUrl: async () => true, withLock: fn => fn(), getBrowser: async () => { throw new Error('no chrome'); } });
      assert.deepEqual(unavailable, { ok: false, reason: 'browser-unavailable' });
      const held = await renderOfficialPostingPage(URL_A, { isPublicUrl: async () => true, withLock: async () => { throw new Error('lock wait aborted'); } });
      assert.deepEqual(held, { ok: false, reason: 'busy' });
      let locked = false;
      const skipped = await renderOfficialPostingPage(URL_A, { isPublicUrl: async () => true, withLock: async () => { locked = true; } });
      assert.deepEqual(skipped, { ok: false, reason: 'busy' });
      assert.equal(locked, false);
      _resetOfficialPostingRenderForTests();
      const cancel = new AbortController(); cancel.abort();
      assert.deepEqual(await renderOfficialPostingPage(URL_A, { signal: cancel.signal }), { ok: false, reason: 'aborted' });
    },
  },
  {
    name: 'Settling waits for stable text and finished requests, tolerates a stuck request, and reports a page that never loads',
    async run() {
      let clock = 0;
      const timing = { now: () => clock, sleep: async ms => { clock += ms; } };
      const grew = seq([0, 0, 50, 900, 900]);
      assert.equal(await waitForPageToSettle({ ...timing, textLength: async () => grew(), pendingRequests: () => 0 }), true);
      assert.ok(clock >= 1_500);
      clock = 0;
      assert.equal(await waitForPageToSettle({ ...timing, textLength: async () => 900, pendingRequests: () => 1 }), true, 'an open request cannot hold real text forever');
      assert.ok(clock >= 5_000 && clock < 15_000);
      clock = 0;
      assert.equal(await waitForPageToSettle({ ...timing, textLength: async () => 0, pendingRequests: () => 0 }), false);
      clock = 0;
      assert.equal(await waitForPageToSettle({ ...timing, textLength: async () => 12, pendingRequests: () => 1 }), false, 'a spinner with a request open never counts');
    },
  },
  {
    name: 'One lookup opens each address once and retries one that failed',
    async run() {
      const calls = [];
      const answers = [{ ok: false, reason: 'load-failed' }, shown()];
      const session = createOfficialPostingRenderSession(async url => { calls.push(url); return answers.shift(); });
      assert.equal((await session(URL_A)).ok, false);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await session(URL_A)).ok, true);
      assert.equal((await session(URL_A)).ok, true);
      assert.equal(calls.length, 2);
    },
  },
  {
    name: 'Judges are told what a rendered snapshot means, and an unreadable page is named on the card',
    run() {
      const job = { title: 'Dispatch Engineer', company: 'Northwind', location: 'Lakeview', snippet: 'Build routing services.', url: 'https://www.linkedin.com/jobs/view/1' };
      const leads = [lead({ employer: 'Northwind' })];
      const { prompt } = buildOfficialPostingJudgeRequest({ job, leads, run: 'A', snapshots: [{ id: 'P1', read: true, rendered: true, pageText: VISIBLE }] });
      assert.match(prompt, /rendered true means the app opened the page in a real browser/u);
      assert.match(prompt, /a visible closed notice with no application control on the page is enough/u);
      const answer = { choice: 'uncertain', postingUrl: '', status: 'unknown', employerLinked: false, conflicts: ['Empty page.'] };
      const decide = snapshots => decideOfficialPostingJudgments(job, { leads, snapshots, answerA: answer, answerB: answer, now: 0, fallback: unresolvedOfficialPosting,
        comparativeTrail: officialPostingComparativeTrail, inputHash: 'x', negativeProofTrail: 'n' }).officialPosting;
      const blocked = decide([{ id: 'P1', read: true, source: 'page', pageText: 'x', renderFailed: 'blocked' }]);
      assert.ok(blocked.trail.includes('page-unreadable'));
      assert.match(officialPostingLookupStatus(blocked).detail, /could not be read, in a plain download or in a browser/u);
      assert.ok(!decide([{ id: 'P1', read: true, source: 'page', rendered: true, pageText: VISIBLE }]).trail.includes('page-unreadable'));
      for (const snapshot of [{ renderFailed: 'busy' }, { renderFailed: 'not-attempted' }, { renderFailed: 'browser-unavailable' }, { renderFailed: 'blocked', pageText: VISIBLE }]) {
        assert.ok(!decide([{ id: 'P1', read: true, source: 'page', ...snapshot }]).trail.includes('page-unreadable'), JSON.stringify(snapshot).slice(0, 60));
      }
    },
  },
  {
    name: 'A closure with no rendered page stays unsettled when a rendered page is required; an open answer, or a rendered page, settles',
    run() {
      const job = { title: 'Dispatch Engineer', company: 'Northwind', location: 'Lakeview', snippet: 'Build routing services.', url: 'https://www.linkedin.com/jobs/view/1' };
      const leads = [lead({ employer: 'Northwind' })];
      const said = status => ({ choice: 'P1', postingUrl: URL_A, status, statusQuote: 'Not accepting new applicants', employerLinked: true,
        employerPageUrl: URL_A, employerLinkQuote: 'Dispatch Engineer', title: 'Dispatch Engineer', employer: 'Northwind', location: 'Lakeview', salary: '',
        description: '', conflicts: [] });
      const decide = (status, snapshots, extra = {}) => decideOfficialPostingJudgments(job, { leads, snapshots, answerA: said(status), answerB: said(status), now: 0,
        fallback: unresolvedOfficialPosting, comparativeTrail: officialPostingComparativeTrail, inputHash: 'x', negativeProofTrail: 'n', employerEqual: (a, b) => a === b, ...extra }).officialPosting;
      const plain = [{ id: 'P1', read: true, source: 'page', pageText: VISIBLE }];
      const rendered = [{ id: 'P1', read: true, source: 'page', rendered: true, pageText: VISIBLE }];
      const unsettled = decide('closed', plain, { closureNeedsRenderedPage: true });
      assert.equal(unsettled.outcome, 'ambiguous');
      assert.ok(unsettled.trail.includes('official-liveness-unconfirmed'));
      assert.equal(decide('closed', rendered, { closureNeedsRenderedPage: true }).outcome, 'closed', 'a rendered page settles the closure');
      assert.equal(decide('closed', plain).outcome, 'closed', 'with no rendered page required it stands as before');
      assert.notEqual(decide('open', plain, { closureNeedsRenderedPage: true }).outcome, 'ambiguous', 'only a closure needs the rendered page');
    },
  },
  {
    name: 'Both AI prompts judge by meaning in any wording, naming "Not accepting new applicants", not only the word closed',
    run() {
      const job = { title: 'Dispatch Engineer', company: 'Northwind', location: 'Lakeview', snippet: 'Build routing services.', url: 'https://www.linkedin.com/jobs/view/1' };
      const { prompt } = buildOfficialPostingJudgeRequest({ job, leads: [lead({ employer: 'Northwind' })], run: 'A', snapshots: [{ id: 'P1', read: true, rendered: true, pageText: VISIBLE }] });
      const member = { row: { source: 'linkedin', title: 'Dispatch Engineer', company: 'Northwind', location: 'Lakeview' }, evidence: { board: 'linkedin',
        requestedUrl: job.url, finalUrl: job.url, httpStatus: 200, title: 'Dispatch Engineer', h1: 'Dispatch Engineer', chromeText: 'Dispatch Engineer', pageBody: VISIBLE,
        descriptionText: '', descriptionIsPage: false, closedHits: [], openSignals: [], jsonLd: { validThrough: '', isListed: null }, redirectedAway: false, titleMatchesPage: true } };
      const listing = buildListingLivenessRequest([member]).prompt;
      for (const text of [prompt, listing]) {
        assert.match(text, /Judge what the page means, not which words it uses/u);
        assert.match(text, /Not accepting new applicants/u);
        assert.match(text, /The word closed need not appear/u);
      }
      assert.match(listing, /closedHits are only places a simple text search noticed/u);
    },
  },
  {
    name: 'The listing prompt sends the whole page, so a quote from beyond the description or hits validates',
    run() {
      const body = `Dispatch Engineer\nNorthwind\n${'Build routing services for delivery teams. '.repeat(40)}\nThis position is not accepting new applicants at this time.`;
      const member = { row: { source: 'linkedin', title: 'Dispatch Engineer', company: 'Northwind', location: 'Lakeview' }, evidence: { board: 'linkedin',
        requestedUrl: 'https://www.linkedin.com/jobs/view/1', finalUrl: 'https://www.linkedin.com/jobs/view/1', httpStatus: 200, title: 'Dispatch Engineer', h1: 'Dispatch Engineer',
        chromeText: 'Dispatch Engineer', pageBody: body, descriptionText: 'Build routing services for delivery teams.', descriptionIsPage: false, closedHits: [],
        openSignals: [], jsonLd: { validThrough: '', isListed: null }, redirectedAway: false, titleMatchesPage: true } };
      const request = buildListingLivenessRequest([member]);
      assert.ok(request.prompt.includes('"pageText":'));
      assert.ok(request.prompt.includes('not accepting new applicants at this time'));
      const quote = 'This position is not accepting new applicants at this time.';
      const result = request.responseValidator({ rows: [{ id: 'r1', verdict: 'closed', quote }] });
      assert.equal(result.rows[0].verdict, 'closed');
      assert.throws(() => validateListingLivenessResponse({ rows: [{ id: 'r1', verdict: 'closed', quote: 'This job was filled yesterday.' }] }, [member]),
        error => { assert.ok(error.correctionRuleIds?.includes('LIVENESS_QUOTE_NOT_ON_PAGE'), JSON.stringify(error.correctionRuleIds)); return true; });
    },
  },
  {
    name: 'A closure needs a page that finished loading and did not answer with an error',
    run() {
      const job = { title: 'Dispatch Engineer', company: 'Northwind', location: 'Lakeview', snippet: 'Build routing services.', url: 'https://www.linkedin.com/jobs/view/1' };
      const leads = [lead({ employer: 'Northwind' })];
      const answer = { choice: 'P1', postingUrl: URL_A, status: 'closed', statusQuote: 'Filled', employerLinked: true, employerPageUrl: URL_A, employerLinkQuote: 'x',
        title: 'Dispatch Engineer', employer: 'Northwind', location: '', salary: '', description: '', evidence: [], conflicts: [] };
      const decide = snapshot => decideOfficialPostingJudgments(job, { leads, snapshots: [{ id: 'P1', read: true, ...snapshot }], answerA: answer, answerB: answer, now: 0, fallback: unresolvedOfficialPosting,
        comparativeTrail: officialPostingComparativeTrail, inputHash: 'x', negativeProofTrail: 'n', employerEqual: () => true, closureNeedsRenderedPage: true }).officialPosting;
      const shown = { pageText: 'Dispatch Engineer\nFilled' };
      const good = decide({ rendered: true, ...shown });
      assert.equal(good.outcome, 'closed');
      assert.ok(good.trail.includes('closure-page-read'));
      for (const bad of [shown, { rendered: true, settled: false, ...shown }, { rendered: true, pageHttpStatus: 403, ...shown }, { rendered: true, pageHttpStatus: 503, ...shown }, { rendered: true }, { rendered: true, pageHttpStatus: 404 }]) {
        assert.equal(decide(bad).outcome, 'ambiguous', JSON.stringify(bad));
      }
      assert.equal(decide({ rendered: true, pageHttpStatus: 404, title: 'Dispatch Engineer', description: 'Build routing services.' }).outcome, 'closed');
    },
  },
  {
    name: 'An error page keeps its status for the judges',
    async run() {
      const [snap] = await snapshotOfficialPostingLeads([lead()], { fetch: shell, render: async () => shown({ status: 503 }) });
      assert.equal(snap.pageHttpStatus, 503);
    },
  },
  {
    name: 'Someone waiting on one card goes ahead of a queued Board, behind others also waiting',
    async run() {
      _resetOfficialPostingRenderForTests();
      const order = []; let release; const gate = new Promise(resolve => { release = resolve; });
      const start = (url, priority) => renderOfficialPostingPage(url, { priority, isPublicUrl: async () => true, withLock: async () => { order.push(url); await gate; return { ok: false, reason: 'load-failed' }; } });
      const all = [start('https://a.test/running'), start('https://a.test/board-1'), start('https://a.test/board-2'), start('https://a.test/card-1', true), start('https://a.test/card-2', true)];
      await new Promise(resolve => setImmediate(resolve));
      release();
      await Promise.all(all);
      assert.deepEqual(order.map(url => url.split('/').pop()), ['running', 'card-1', 'card-2', 'board-1', 'board-2']);
      _resetOfficialPostingRenderForTests();
    },
  },
  {
    name: 'Trimming shortens only the longest pages, evenly, and stays within the bound',
    run() {
      const snaps = [{ id: 'P1', pageText: 'a'.repeat(120_000) }, ...[2, 3, 4, 5, 6].map(n => ({ id: `P${n}`, pageText: 'b'.repeat(60_000) })), { id: 'P7', pageText: 'short' }];
      trimOfficialPostingSnapshots(snaps);
      assert.ok(JSON.stringify(snaps).length <= SNAPSHOT_TOTAL_CHARS);
      assert.ok(snaps[0].pageText.length > 30_000, 'the posting page keeps a fair share');
      assert.equal(snaps[0].pageText.length, snaps[1].pageText.length);
      assert.equal(snaps[6].pageText, 'short');
      assert.equal(snaps[0].pageTextTruncated, true);
      assert.equal(snaps[6].pageTextTruncated, undefined);
    },
  },
  {
    name: 'A reader fills only the unread https pages the app could not download, never one that said not found or was read',
    async run() {
      const readerCalls = [];
      const readPage = async (url, options) => { readerCalls.push({ url, signal: options?.signal }); return `  ${READER_TEXT}  `; };
      const fetch = async url => {
        if (url === 'https://careers.northwind.test/job/gone') return gone(url);
        if (url === URL_A) return blocked(url);
        if (url.startsWith('http:')) return blocked(url);
        return shell(url);
      };
      const leads = [lead(), lead({ id: 'P2', url: 'https://careers.northwind.test/job/gone' }),
        lead({ id: 'P3', url: 'https://boards.northwind.test/job/read' }),
        lead({ id: 'P4', url: 'http://careers.northwind.test/job/plain' })];
      const snaps = await snapshotOfficialPostingLeads(leads, { fetch, readPage, signal: undefined });
      assert.deepEqual(readerCalls.map(call => call.url), [URL_A]);
      assert.equal(snaps[0].pageText, READER_TEXT);
      assert.equal(snaps[0].read, true);
      assert.equal(snaps[0].reader, 'page-reader');
      assert.equal(snaps[0].httpStatus, 403, 'the status stays for diagnosis');
      assert.equal('rendered' in snaps[0], false, 'a reader page is text, not what a person saw');
      assert.equal(snaps[1].notFound, true);
      assert.equal(snaps[1].read, false);
      assert.equal(snaps[1].reader, undefined);
      assert.equal(snaps[2].read, true);
      assert.equal(snaps[2].reader, undefined);
      assert.equal(snaps[3].read, false);
      assert.equal(snaps[3].pageText, undefined);
    },
  },
  {
    name: 'A reader that throws or returns nothing leaves the page unread, and read health sees the download itself',
    async run() {
      const observed = [];
      // What read health sees is synchronous: copy the final snapshots at the moment it is handed them.
      const watch = value => observed.push({ ...value, final: value.final.map(snapshot => ({ ...snapshot })) });
      const throwing = await snapshotOfficialPostingLeads([lead()], { fetch: blocked,
        readPage: async () => { throw new Error('reader down'); }, observe: watch });
      assert.equal(throwing[0].read, false);
      assert.equal(throwing[0].reader, undefined);
      assert.equal(throwing[0].pageText, undefined);
      assert.equal(throwing[0].httpStatus, 403);
      const empty = await snapshotOfficialPostingLeads([lead()], { fetch: blocked, readPage: async () => '   ' });
      assert.equal(empty[0].read, false);
      assert.equal(empty[0].reader, undefined);
      const filled = await snapshotOfficialPostingLeads([lead()], { fetch: blocked, readPage: async () => `  ${READER_TEXT}  `,
        observe: watch });
      assert.equal(observed.at(-1).final[0].read, false, 'the monitor saw the blocked download, not the reader');
      assert.equal(observed.at(-1).final[0].pageText, undefined);
      assert.equal(filled[0].read, true);
      assert.equal(filled[0].reader, 'page-reader');
    },
  },
  {
    name: 'A lookup with an injected download never reaches the default reader, so a challenged lead stays unread',
    async run() {
      const entries = await challengedLookup(undefined);
      assert.ok(entries.length > 0, 'the judges recorded what they were given');
      const snapshots = entries.flatMap(entry => entry.snapshots || []);
      assert.ok(snapshots.some(snapshot => snapshot.read === false && snapshot.httpStatus === 202));
      assert.deepEqual(snapshots.filter(snapshot => snapshot.reader), []);
      assert.deepEqual(snapshots.filter(snapshot => snapshot.pageTextChars > 0), []);
    },
  },
  {
    name: 'A lookup uses an injected reader and its judgments log says which pages a reader filled in',
    async run() {
      const readerCalls = [];
      const entries = await challengedLookup(async (url, options) => { readerCalls.push({ url, signal: options?.signal }); return READER_TEXT; });
      assert.deepEqual([...new Set(readerCalls.map(call => call.url))].sort(), [CAREERS, POSTING].sort());
      const snapshots = entries.flatMap(entry => entry.snapshots || []);
      const filled = snapshots.filter(snapshot => snapshot.reader === 'page-reader');
      assert.ok(filled.length > 0, 'the log records the reader');
      assert.ok(filled.every(snapshot => snapshot.read === true && snapshot.pageTextChars > 0));
      assert.ok(filled.every(snapshot => snapshot.rendered === undefined));
      assert.ok(!snapshots.some(snapshot => snapshot.read === false), 'every challenged page was read');
    },
  },
];
