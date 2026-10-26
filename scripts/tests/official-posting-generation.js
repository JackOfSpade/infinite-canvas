import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import electronPkg from 'electron';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';
import { createOfficialPostingPrepareSemaphore, getPreparedOfficialPosting, prepareOfficialPostingForGeneration, registerOfficialPostingGenerationHandlers } from '../../electron/ipc/officialPostingGeneration.js';
import { abortNodeTasksAndWait, beginSenderQuitPause, releaseSenderQuitPause, snapshotActiveNodeTasks } from '../../electron/ipc/ipcUtils.js';

const text = 'Requirements include experience building reliable dispatch tools and maintaining reporting workflows. Engineers design clear interfaces for operations teams and validate changes through careful review. The role improves data quality across scheduled pipelines and documents decisions for partner groups. You will collaborate with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving tools that support teams use every day.';
const place = 'Lakeview, Ontario, Canada';
const officialUrl = 'https://northwind.test/jobs/one';
const job = (extra = {}) => ({ title: 'Software Engineer at Northwind Labs', company: 'Acme Talent Partners', location: place,
  snippet: `Our client is hiring. ${text}`, url: 'https://mirror.example/jobs/one', sourceJobKey: 'synthetic-one', ...extra });
const args = (value = job(), cardId = 'card-one') => ({ nodeId: 'board-one', cardId, manualAiRunId: `official-posting:${cardId}:run`, job: value });
const posting = (extra = {}) => ({ level: 'L1', outcome: 'found', employer: 'Northwind Labs', title: 'Software Engineer',
  location: { display: place, remote: false, workMode: '', remoteCountry: '', remoteRegion: '' },
  salary: { text: '', provenance: 'unknown' }, sourceUrl: officialUrl, officialApplyUrl: officialUrl,
  ats: '', tenant: '', trail: ['description-anchor'], ...extra });
const status = () => ({ enabled: true, link: { state: 'linked' }, chat: { pool: { active: true } } });
function page(description = text, extra = {}) { return `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
  title: 'Software Engineer', hiringOrganization: { name: 'Northwind Labs' }, description,
  jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, ...extra })}</script>`; }
function livenessPage({ description = text, notice = '', extra = {} } = {}) {
  const surrounding = 'The careers page explains interview steps, team structure, benefits and working arrangements for candidates. '.repeat(5);
  return `<html><head><title>Software Engineer</title></head><body>${page(description, extra)}<main><h1>Software Engineer</h1><p>${description}</p><p>${surrounding}</p><aside>${notice}</aside></main></body></html>`;
}
function network(pages, calls = []) { return async url => { calls.push(url); const value = pages[url];
  if (!value) { const error = new Error('closed'); error.code = 'closed'; throw error; }
  return { url, contentType: 'text/html', statusCode: 200, ...(typeof value === 'string' ? { body: value } : value) };
}; }
async function withStore(run, options) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-generation-'));
  try { await run(createOfficialPostingStore(path.join(root, 'official-postings'), options)); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
async function waitFor(predicate) { for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate(), 'expected asynchronous boundary is reached'); }
const fallbackResolve = async rows => ({ jobs: rows.map(row => ({ ...row, officialPosting: { level: 'L5', outcome: 'not-found', employer: row.company, trail: [] } })) });

export default [
  {
    name: 'official-posting prepare re-extracts changed host text, marks unavailable bridge and binds an opaque immutable record to exact scraped identity and aliases',
    async run() {
      await withStore(async store => {
        const original = job(); const before = JSON.stringify(original);
        const old = await store.save(original, { officialPosting: posting(), description: text });
        const changed = `${text} The current posting also includes reviewing route access policies.`;
        const prepared = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: () => ({ enabled: false }), fetch: network({ [officialUrl]: page(changed) }) });
        assert.equal(JSON.stringify(original), before); assert.match(prepared.resolutionId, /^[a-f0-9-]{36}$/u);
        assert.equal(prepared.officialPosting.level, 'L1'); assert.equal(prepared.postedBy, original.company);
        assert.ok(prepared.officialPosting.trail.includes('bridge-unavailable')); assert.ok(prepared.officialPosting.trail.includes('reverified'));
        assert.notEqual(prepared.officialPosting.contentHash, old.officialPosting.contentHash);
        const trusted = getPreparedOfficialPosting(prepared.resolutionId, original);
        assert.equal(trusted.description, changed); assert.equal(trusted.applyUrl, officialUrl); assert.equal(trusted.scrapedJob.company, original.company);
        for (const change of [{ title: 'Staff Engineer at Northwind Labs' }, { company: 'Other Talent Partners' }, { location: 'Riverton, Alberta, Canada' }, { url: 'https://mirror.example/jobs/two' }]) {
          assert.equal(getPreparedOfficialPosting(prepared.resolutionId, { ...original, ...change }), null);
        }
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, changed, 'foreign attempts do not consume the real queue entry');
        trusted.description = 'Changed by caller'; assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, changed);
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original, { now: trusted.createdAt + 24 * 60 * 60 * 1000 }), null);
      });
    },
  },
  {
    name: 'official-posting prepare drops explicit 404 postings while preserving cached proof on weak expired wrong-title or redirected pages',
    async run() {
      for (const kind of ['closed', 'expired', 'title', 'redirect']) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        const fetched = kind === 'closed' ? {} : { [officialUrl]: kind === 'redirect'
          ? { url: 'https://elsewhere.example/jobs/foreign', body: page() }
          : page(text, kind === 'expired' ? { validThrough: '2000-01-01T00:00:00Z' } : { title: 'Staff Engineer' }) };
        const read = network(fetched);
        const prepared = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: status, fetch: kind === 'closed'
          ? async () => { throw Object.assign(new Error('closed'), { code: 'closed', statusCode: 404 }); } : read });
        assert.equal(prepared.officialPosting.level, kind === 'closed' ? 'L6' : 'L1', kind);
        assert.equal(prepared.officialPosting.officialApplyUrl, kind === 'closed' ? undefined : officialUrl, kind);
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, kind === 'closed' ? undefined : text);
        if (kind === 'closed') {
          assert.equal(prepared.officialPosting.outcome, 'closed'); assert.equal((await store.find(original)).officialPosting.outcome, 'closed');
        } else assert.ok(prepared.officialPosting.trail.includes('reverify-failed'), kind);
      });
    },
  },
  {
    name: 'official-page expiry is demoted only after quoted AI closure and checks the board link in the same Generate',
    async run() {
      await withStore(async store => {
        const original = job({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/synthetic-one' });
        await store.save(original, { officialPosting: posting(), description: text });
        const now = Date.parse('2026-10-26T12:00:00Z');
        let aiCalls = 0; let boardVisits = 0;
        const prepared = await prepareOfficialPostingForGeneration(args(original), {
          store, now: () => now, bridgeStatus: status,
          fetch: network({ [officialUrl]: livenessPage({ notice: 'Applications for this opening have ended.',
            extra: { validThrough: '2000-01-01T00:00:00Z' } }) }),
          callText: async (_prompt, request) => {
            aiCalls += 1; assert.equal(request.task, 'job-listing-liveness');
            return { rows: [{ id: 'r1', verdict: 'closed', quote: 'Applications for this opening have ended.' }] };
          },
          listingProbe: { probe: async url => { boardVisits += 1; assert.equal(url, original.url);
            return { board: 'linkedin', ruleKey: 'linkedin', requestedUrl: url, finalUrl: url,
              httpStatus: 404, title: 'Page not found', chromeText: 'This posting could not be found.' }; } },
        });
        assert.equal(aiCalls, 1); assert.equal(boardVisits, 1);
        assert.equal(prepared.officialPosting.level, 'L6'); assert.equal(prepared.officialPosting.outcome, 'closed');
        assert.equal(prepared.listingCheck.action, 'refuse-final');
        assert.equal(prepared.boardClosed.reason, 'http-not-found');
        assert.equal((await store.find(original)).officialPosting.outcome, 'closed');
      });
    },
  },
  {
    name: 'official-page outside-description closure needs AI while description wording and mismatched pages never invoke it',
    async run() {
      await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        let calls = 0;
        const result = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          fetch: network({ [officialUrl]: livenessPage({ notice: 'This position has been filled.' }) }),
          callText: async () => { calls += 1; return { rows: [{ id: 'r1', verdict: 'closed', quote: 'This position has been filled.' }] }; } });
        assert.equal(calls, 1); assert.equal(result.officialPosting.level, 'L6'); assert.equal(result.officialPosting.outcome, 'closed');
      });
      for (const kind of ['description', 'title', 'redirect', 'unreadable', 'server']) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        const inside = `${text} This position has been filled.`;
        const value = kind === 'description' ? livenessPage({ description: inside })
          : kind === 'title' ? livenessPage({ notice: 'This position has been filled.', extra: { title: 'Staff Engineer' } })
            : kind === 'redirect' ? { url: 'https://elsewhere.example/jobs/foreign', body: livenessPage({ notice: 'This position has been filled.' }) }
              : kind === 'unreadable' ? '<main><h1>Software Engineer</h1><p>This position has been filled.</p></main>'
                : { statusCode: 503, body: livenessPage({ notice: 'This position has been filled.' }) };
        let calls = 0;
        const result = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: status,
          fetch: network({ [officialUrl]: value }), callText: async () => { calls += 1; return { rows: [{ id: 'r1', verdict: 'closed', quote: 'This position has been filled.' }] }; } });
        assert.equal(calls, 0, kind); assert.equal(result.officialPosting.level, 'L1', kind);
        assert.notEqual(result.officialPosting.outcome, 'closed', kind);
      });
    },
  },
  {
    name: 'official-page unconfirmed expiry preserves the prior proof with a bounded liveness audit fact',
    async run() {
      for (const kind of ['unavailable', 'unclear', 'no-quote', 'description-quote', 'json-only-quote', 'timeout']) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting(), description: text });
        let calls = 0;
        const body = kind === 'json-only-quote'
          ? `<html><body>${page(text, { validThrough: '2000-01-01T00:00:00Z' })}<main><h1>Software Engineer</h1><p>${'Candidates can read the application steps and learn about the hiring process. '.repeat(4)}</p></main></body></html>`
          : livenessPage({ extra: { validThrough: '2000-01-01T00:00:00Z' } });
        const prepared = await prepareOfficialPostingForGeneration(args(original), {
          store, bridgeStatus: kind === 'unavailable' ? () => ({ enabled: false }) : status,
          fetch: network({ [officialUrl]: body }),
          callText: async () => {
            calls += 1;
            if (kind === 'timeout') throw Object.assign(new Error('timed out'), { code: 'bridge-timeout' });
            return { rows: [{ id: 'r1', verdict: kind === 'unclear' ? 'unclear' : 'closed',
              quote: ['description-quote', 'json-only-quote'].includes(kind) ? 'Engineers design clear interfaces' : '' }] };
          },
        });
        assert.equal(calls, kind === 'unavailable' ? 0 : 1, kind);
        assert.equal(prepared.officialPosting.level, 'L1', kind);
        assert.ok(prepared.officialPosting.trail.includes('reverify-failed'), kind);
        assert.ok(prepared.officialPosting.trail.includes('official-liveness-unconfirmed'), kind);
        assert.equal((await store.find(original)).officialPosting.outcome, 'found', kind);
      });
    },
  },
  {
    name: 'official-posting prepare freezes confirmed-open-or-unknown variants after the primary decision',
    async run() {
      const closedUrl = 'https://www.linkedin.com/jobs/view/synthetic-variant-closed';
      const unknownUrl = 'https://www.linkedin.com/jobs/view/synthetic-variant-unknown';
      const original = job({ postingVariants: [
        { location: 'North', url: closedUrl }, { location: 'South', url: unknownUrl },
      ] });
      const visits = [];
      const prepared = await prepareOfficialPostingForGeneration(args(original), {
        store: { find: async () => null }, resolve: fallbackResolve,
        bridgeStatus: () => ({ enabled: false }),
        listingProbe: { probe: async url => { visits.push(url);
          if (url === closedUrl) return { requestedUrl: url, finalUrl: url, httpStatus: 404,
            board: 'linkedin', ruleKey: 'linkedin', title: 'Page not found', chromeText: 'Page not found' };
          return { unknown: true }; } },
      });
      assert.equal(prepared.listingCheck.action, 'proceed');
      assert.deepEqual(visits, [closedUrl, unknownUrl]);
      assert.deepEqual(prepared.postingVariants.map(variant => variant.location), ['South']);
      const frozen = getPreparedOfficialPosting(prepared.resolutionId, original);
      assert.deepEqual(frozen.postingVariants, prepared.postingVariants);
      assert.deepEqual(frozen.scrapedJob.postingVariants, original.postingVariants,
        'variant filtering must not change scraped identity');
    },
  },
  {
    name: 'official-posting prepare can re-read a live JS ATS source only through its proven tenant API and exact stored posting URL',
    async run() {
      const url = 'https://jobs.ashbyhq.com/northwind/req-one';
      const api = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
      for (const foreign of [false, true]) await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: posting({ level: 'L2', ats: 'ashby', tenant: 'northwind', sourceUrl: url, officialApplyUrl: url }), description: text });
        const calls = []; const changed = `${text} Additional responsibilities include reviewing shared release checklists.`;
        const prepared = await prepareOfficialPostingForGeneration(args(original), { store, bridgeStatus: status, fetch: network({
          [url]: '<main>A JavaScript application loads the role.</main>', [api]: { contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 'req-one', title: 'Software Engineer',
            location: place, isListed: true, descriptionPlain: changed, jobUrl: foreign ? 'https://jobs.ashbyhq.com/other/req-one' : url, applyUrl: url }] }) },
        }, calls) });
        assert.deepEqual(calls, [url, api]);
        assert.equal(prepared.officialPosting.level, 'L2');
        assert.equal(getPreparedOfficialPosting(prepared.resolutionId, original).description, foreign ? text : changed);
        assert.equal(prepared.officialPosting.trail.includes('reverify-failed'), foreign);
      });
    },
  },
  {
    name: 'official-posting prepare preserves recent misses without research, retries expired misses and checks actual bridge status before slot/store work',
    async run() {
      let time = Date.parse('2026-01-01T00:00:00Z');
      await withStore(async store => {
        const original = job(); await store.save(original, { officialPosting: { level: 'L6', outcome: 'not-found', employer: '', trail: ['bridge-research'] } });
        let calls = 0; const order = [];
        const options = { store: { ...store, find: async row => { order.push('store'); return store.find(row); } }, now: () => time,
          bridgeStatus: () => { order.push('status'); return status(); }, slots: { acquire: async () => { order.push('slot'); return () => {}; } },
          resolve: async (rows, options) => { calls++; assert.equal(options.manualAiRunId, args().manualAiRunId); assert.equal(options.nodeId, 'board-one'); return fallbackResolve(rows); } };
        const recent = await prepareOfficialPostingForGeneration(args(original), options);
        assert.equal(calls, 0); assert.ok(recent.officialPosting.trail.includes('recent-miss')); assert.deepEqual(order, ['status', 'slot', 'store']);
        time += 24 * 60 * 60 * 1000;
        await prepareOfficialPostingForGeneration(args(original), options); assert.equal(calls, 1);
      }, { now: () => time });
    },
  },
  {
    name: 'official-posting prepare admits only three operations and its whole budget includes a cancellable slot wait',
    async run() {
      await withStore(async store => {
        const slots = createOfficialPostingPrepareSemaphore(); const releases = []; let running = 0; let peak = 0;
        const resolve = async rows => { running++; peak = Math.max(peak, running); const gate = deferred(); releases.push(gate);
          await gate.promise; running--; return fallbackResolve(rows); };
        const prepare = index => prepareOfficialPostingForGeneration(args(job({ url: `https://mirror.example/jobs/${index}`, sourceJobKey: String(index) }), `card-${index}`), { store, slots, bridgeStatus: status, resolve });
        const pending = [prepare(1), prepare(2), prepare(3), prepare(4)]; await waitFor(() => releases.length === 3);
        assert.equal(releases.length, 3); assert.equal(peak, 3);
        releases[0].resolve(); await waitFor(() => releases.length === 4); assert.equal(releases.length, 4);
        releases.slice(1).forEach(gate => gate.resolve()); await Promise.all(pending); assert.equal(peak, 3);
        const single = createOfficialPostingPrepareSemaphore(1); const release = await single.acquire();
        let invoked = false;
        const timed = prepareOfficialPostingForGeneration(args(job({ sourceJobKey: 'waiting' })), { store, slots: single, bridgeStatus: status,
          timeoutMs: 5, resolve: async rows => { invoked = true; return fallbackResolve(rows); } });
        const keepAlive = setTimeout(() => {}, 25); const result = await timed; clearTimeout(keepAlive); release();
        assert.equal(invoked, false); assert.ok(result.officialPosting.trail.includes('bridge-timeout'));
      });
    },
  },
  {
    name: 'official-posting prepare IPC registers one controller under validated Board and card ownership and reports explicit cancellation',
    async run() {
      await withStore(async store => {
        const previous = electronPkg.ipcMain.__getInvokeHandler('prepare-official-posting-for-generation');
        const sender = new EventEmitter(); sender.id = 9071; sender.isDestroyed = () => false;
        try {
          registerOfficialPostingGenerationHandlers({ projectJob: row => ({ ...row }), store, bridgeStatus: status,
            resolve: async (_rows, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
          const invoke = electronPkg.ipcMain.__getInvokeHandler('prepare-official-posting-for-generation');
          const first = invoke({ sender }, args(job(), 'card-a'));
          const second = invoke({ sender }, args(job({ sourceJobKey: 'second', url: 'https://mirror.example/jobs/second' }), 'card-b'));
          await flush();
          const owners = snapshotActiveNodeTasks(sender.id); assert.equal(owners.find(owner => owner.nodeId === 'board-one').taskCount, 2);
          assert.equal(owners.find(owner => owner.nodeId === 'card-a').taskCount, 1);
          await abortNodeTasksAndWait('card-a', sender); assert.equal((await first).cancelled, true);
          assert.ok(snapshotActiveNodeTasks(sender.id).some(owner => owner.nodeId === 'card-b'));
          await abortNodeTasksAndWait('board-one', sender); assert.equal((await second).cancelled, true);
          assert.deepEqual(snapshotActiveNodeTasks(sender.id), []);
          assert.equal((await invoke({ sender }, { ...args(), cardId: { bad: true } })).success, false); assert.deepEqual(snapshotActiveNodeTasks(sender.id), []);
          beginSenderQuitPause(sender);
          assert.equal((await invoke({ sender }, args())).errorCode, 'APP_QUIT_PAUSED');
        } finally { releaseSenderQuitPause(sender); if (previous) electronPkg.ipcMain.handle('prepare-official-posting-for-generation', previous); }
      });
    },
  },
];
