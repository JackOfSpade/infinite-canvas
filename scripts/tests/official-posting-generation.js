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
