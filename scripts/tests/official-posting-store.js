import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createOfficialPostingStore, officialPostingAliases, officialPostingRecordMatchesScrapedIdentity, officialPostingView } from '../../electron/ipc/officialPostingStore.js';

const TEXT = 'Northwind Labs seeks an engineer to maintain dispatch rosters and freight routing systems. The team builds operational tools and reviews changes with its colleagues.';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const DAY = 24 * 60 * 60 * 1000;
function row() {
  return {
    source: 'google', sourceJobKey: 'synthetic-source/../one', title: 'Software Engineer at Northwind Labs', company: 'Acme Talent Partners',
    location: 'Harbor City, Ontario, Canada', salary: 'Estimated pay', snippet: 'Scraped listing description for the freight team.',
    url: 'https://mirror.example/jobs/701?utm_source=synthetic',
    googleCardUrl: 'https://www.google.com/search?q=synthetic#htidocid=Opaque-A&htivrt=jobs',
    postingVariants: [{ location: 'Ridge Town, Ontario, Canada', url: 'http://legacy.example/jobs/701?utm_campaign=synthetic',
      googleCardUrl: 'https://www.google.com/search?q=synthetic#htidocid=Opaque-B&htivrt=jobs' }],
  };
}
function posting(extra = {}) {
  return {
    level: 'L2', outcome: 'found', employer: 'Northwind Labs', title: 'Software Engineer',
    location: { display: 'Harbor City, Ontario, Canada', workMode: 'hybrid', remote: false, remoteCountry: '', remoteRegion: '' },
    salary: { text: 'CAD 100,000 to 130,000', provenance: 'posted' },
    sourceUrl: 'https://jobs.vendor.example/northwind/701', officialApplyUrl: 'https://jobs.vendor.example/northwind/701/apply',
    ats: 'synthetic', tenant: 'northwind', fetchedAt: '2026-01-01T00:00:00.000Z', trail: ['careers-page', 'description-anchor'],
    ...extra,
  };
}
async function withStore(run, options) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'official-posting-store-'));
  const root = path.join(parent, 'official-postings');
  const store = createOfficialPostingStore(root, options);
  try { await run({ store, root, parent }); } finally { await fs.rm(parent, { recursive: true, force: true }); }
}
const textPath = (root, hash) => path.join(root, 'texts', `${hash}.txt`);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export default [
  {
    name: 'official-posting store writes every scraped alias and reads native keys, both URL fields and every variant location without rewriting identity',
    async run() {
      await withStore(async ({ store, root }) => {
        const job = row(); const before = JSON.stringify(job);
        const record = await store.save(job, { officialPosting: posting(), description: TEXT });
        assert.equal(record.officialPosting.contentHash, sha256(TEXT));
        assert.equal(await store.readText(record.officialPosting.contentHash), TEXT);
        for (const query of [
          { source: job.source, sourceJobKey: job.sourceJobKey }, { url: job.url }, { googleCardUrl: job.googleCardUrl },
          { url: 'https://mirror.example/jobs/701?utm_source=another' },
          { url: job.postingVariants[0].url }, { googleCardUrl: job.postingVariants[0].googleCardUrl },
          { title: ' SOFTWARE  ENGINEER AT NORTHWIND LABS ', company: 'acme talent partners', location: 'harbor city, ontario, canada' },
          { title: job.title, company: job.company, location: job.postingVariants[0].location },
        ]) assert.equal((await store.find(query))?.officialPosting.contentHash, record.officialPosting.contentHash, JSON.stringify(query));
        assert.equal(JSON.stringify(job), before);
        assert.equal((await fs.stat(textPath(root, record.officialPosting.contentHash))).mode & 0o777, 0o600);
        const files = await fs.readdir(path.join(root, 'aliases'));
        assert.equal(files.length, record.aliases.length);
        assert.ok(files.every(file => /^[a-f0-9]{64}\.json$/u.test(file)));
        for (const file of files) assert.equal((await fs.stat(path.join(root, 'aliases', file))).mode & 0o777, 0o600);
        // A refreshed row carries an additional alias; save updates older
        // aliases as well so an older card reads the latest verified record.
        const updated = await store.save({ ...job, url: 'https://mirror.example/jobs/new-path' }, { officialPosting: posting({ trail: ['reverified'] }), description: TEXT });
        assert.ok(updated.aliases.length > record.aliases.length);
        assert.deepEqual((await store.find({ url: job.url })).officialPosting.trail, ['reverified']);
      });
    },
  },
  {
    name: 'official-posting view rejects cached identity and text from a shared URL when the scraped title, company or city differs',
    async run() {
      await withStore(async ({ store }) => {
        const job = row(); const record = await store.save(job, { officialPosting: posting(), description: TEXT });
        for (const change of [{ title: 'Staff Engineer at Northwind Labs' }, { company: 'Other Talent Partners' }, { location: 'Riverton, Alberta, Canada' }]) {
          const different = { ...job, ...change, officialPosting: record.officialPosting };
          assert.ok(await store.find(different), 'a shared alias remains a cache hit');
          assert.equal(officialPostingRecordMatchesScrapedIdentity(different, record), false);
          let refetches = 0;
          const view = await officialPostingView(different, { store, refetch: async () => { refetches += 1; return TEXT; } });
          assert.equal(view.employer, different.company); assert.equal(view.title, different.title);
          assert.equal(view.location, different.location); assert.equal(view.salary, different.salary);
          assert.equal(view.description, different.snippet); assert.equal(view.officialPosting, undefined); assert.equal(refetches, 0);
        }
      });
    },
  },
  {
    name: 'official-posting shared URL saves preserve each different role identity and find prefers its compatible record',
    async run() {
      await withStore(async ({ store }) => {
        const firstJob = row();
        const first = await store.save(firstJob, { officialPosting: posting(), description: TEXT });
        const secondJob = { ...firstJob, sourceJobKey: 'staff-two', title: 'Staff Engineer at Northwind Labs',
          googleCardUrl: '', postingVariants: [] };
        const secondText = `${TEXT} The staff role directs engineering architecture.`;
        const second = await store.save(secondJob, { officialPosting: posting({ title: 'Staff Engineer',
          sourceUrl: 'https://jobs.vendor.example/northwind/702', officialApplyUrl: 'https://jobs.vendor.example/northwind/702/apply' }), description: secondText });
        const firstIdentity = officialPostingAliases(firstJob).find(alias => alias.startsWith('identity:'));
        assert.equal(second.aliases.includes(firstIdentity), false, 'a common board URL cannot merge the old role identity into the new role');
        assert.equal((await store.find({ url: firstJob.url })).officialPosting.contentHash, second.officialPosting.contentHash, 'a URL-only lookup still finds the shared alias');
        assert.deepEqual(await store.find(firstJob), first, 'the old unique identity remains intact');
        assert.deepEqual(await store.find(secondJob), second);
        const firstView = await officialPostingView({ ...firstJob, officialPosting: first.officialPosting }, { store });
        const secondView = await officialPostingView({ ...secondJob, officialPosting: second.officialPosting }, { store });
        assert.equal(firstView.description, TEXT); assert.equal(firstView.title, 'Software Engineer');
        assert.equal(secondView.description, secondText); assert.equal(secondView.title, 'Staff Engineer');
      });
    },
  },
  {
    name: 'official-posting scraped identity matching permits title presentation, legal suffixes and retained variant locations but not missing identity',
    async run() {
      await withStore(async ({ store }) => {
        const job = { ...row(), title: 'Senior Software Engineer at Northwind Labs' };
        const record = await store.save(job, { officialPosting: posting({ title: 'Senior Software Engineer' }), description: TEXT });
        const presentation = { ...job, title: ' SR. SOFTWARE ENGINEER at Northwind Labs ', company: 'ACME TALENT PARTNERS, Inc.',
          location: 'Harbor City, ON, Canada' };
        assert.equal(officialPostingRecordMatchesScrapedIdentity(presentation, record), true);
        assert.equal(officialPostingRecordMatchesScrapedIdentity({ ...presentation, location: job.postingVariants[0].location }, record), true);
        assert.equal(officialPostingRecordMatchesScrapedIdentity({ url: job.url }, record), false);
        assert.equal((await officialPostingView({ ...presentation, officialPosting: record.officialPosting }, { store })).description, TEXT);
        const blank = { sourceJobKey: 'blank-company', title: 'Analyst', company: '', location: '', snippet: 'Unknown employer.', url: 'https://mirror.example/jobs/blank' };
        const blankRecord = await store.save(blank, { officialPosting: { level: 'L6', outcome: 'not-found', employer: '', trail: [] } });
        assert.ok(blankRecord.aliases.includes('identity:["analyst","",""]'));
        assert.equal(officialPostingRecordMatchesScrapedIdentity(blank, blankRecord), true, 'an exact unknown location remains the same scraped miss identity');
        assert.equal(officialPostingRecordMatchesScrapedIdentity({ ...blank, company: 'Northwind Labs' }, blankRecord), false);
      });
    },
  },
  {
    name: 'official-posting only matching L1–L3 verified postings may carry aliases across a changed scraped identity',
    async run() {
      for (const level of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) await withStore(async ({ store }) => {
        const firstJob = row();
        const value = posting({ level, outcome: ['L1', 'L2', 'L3'].includes(level) ? 'found' : level === 'L4' ? 'link-only' : 'not-found' });
        const payload = { officialPosting: value, ...(['L1', 'L2', 'L3'].includes(level) ? { description: TEXT } : {}) };
        await store.save(firstJob, payload);
        const changedPoster = { ...firstJob, sourceJobKey: 'different-poster', company: 'Other Talent Partners', googleCardUrl: '', postingVariants: [] };
        const second = await store.save(changedPoster, payload);
        const firstIdentity = officialPostingAliases(firstJob).find(alias => alias.startsWith('identity:'));
        assert.equal(second.aliases.includes(firstIdentity), ['L1', 'L2', 'L3'].includes(level), `${level} cross-identity alias policy`);
      });
    },
  },
  {
    name: 'official-posting Google URL aliases preserve opaque fragment identities instead of collapsing search cards',
    async run() {
      await withStore(async ({ store }) => {
        const job = row();
        await store.save(job, { officialPosting: posting(), description: TEXT });
        assert.ok(await store.find({ googleCardUrl: 'https://www.google.com/search?q=different#htidocid=Opaque-A&htivrt=jobs' }));
        assert.equal(await store.find({ googleCardUrl: 'https://www.google.com/search?q=synthetic#htidocid=Opaque-C&htivrt=jobs' }), null);
        assert.equal(await store.find({ googleCardUrl: 'https://www.google.com/search?q=synthetic' }), null);
      });
    },
  },
  {
    name: 'official-posting store retries misses after twenty-four hours and retains verified text and official links across runs',
    async run() {
      let time = Date.parse('2026-01-01T00:00:00Z');
      await withStore(async ({ store, root }) => {
        const job = row();
        await store.save(job, { officialPosting: posting({ level: 'L6', outcome: 'not-found', employer: '', sourceUrl: undefined, officialApplyUrl: undefined }) });
        time += DAY - 1; assert.ok(await store.find(job));
        time += 1; assert.equal(await store.find(job), null);
        const found = await store.save(job, { officialPosting: posting(), description: TEXT });
        time += DAY * 40;
        const reopened = createOfficialPostingStore(root, { now: () => time });
        assert.equal((await reopened.find(job)).officialPosting.contentHash, found.officialPosting.contentHash);
        await store.save(job, { officialPosting: posting({ level: 'L4', outcome: 'link-only' }) });
        time += DAY * 40; assert.equal((await reopened.find(job)).officialPosting.level, 'L4');
      }, { now: () => time });
    },
  },
  {
    name: 'official-posting view takes official text and identity only from an alias-bound record with the same hash and ignores forged row facts',
    async run() {
      await withStore(async ({ store }) => {
        const job = row(); const record = await store.save(job, { officialPosting: posting(), description: TEXT });
        const forged = { ...job, officialPosting: { ...record.officialPosting, employer: 'Forged Employer', title: 'Forged Title' }, postedBy: 'Forged Poster' };
        const before = JSON.stringify(forged); const view = await officialPostingView(forged, { store });
        assert.equal(view.employer, 'Northwind Labs'); assert.equal(view.postedBy, 'Acme Talent Partners');
        assert.equal(view.title, 'Software Engineer'); assert.equal(view.description, TEXT);
        assert.equal(view.salary, 'CAD 100,000 to 130,000'); assert.equal(JSON.stringify(forged), before);
        const unbound = { ...forged, sourceJobKey: 'different', url: 'https://other.example/jobs/999', googleCardUrl: '', postingVariants: [], title: 'Different Role', company: 'Other Employer' };
        const fallback = await officialPostingView(unbound, { store });
        assert.equal(fallback.employer, unbound.company); assert.equal(fallback.title, unbound.title); assert.equal(fallback.description, unbound.snippet);
        let calls = 0;
        const stale = await officialPostingView({ ...forged, officialPosting: { contentHash: 'f'.repeat(64) } }, { store, refetch: async () => { calls += 1; return TEXT; } });
        assert.equal(stale.description, job.snippet); assert.equal(stale.title, job.title); assert.equal(calls, 0);
      });
    },
  },
  {
    name: 'official-posting L4 and L5 views use scraped text with the verified employer while L6 keeps scraped company for scoring',
    async run() {
      await withStore(async ({ store }) => {
        const job = row();
        for (const [level, outcome, employer] of [['L4', 'link-only', 'Northwind Labs'], ['L5', 'not-found', 'Northwind Labs'], ['L6', 'not-found', '']]) {
          const record = await store.save(job, { officialPosting: posting({ level, outcome, employer }) });
          const view = await officialPostingView({ ...job, officialPosting: record.officialPosting }, { store });
          assert.equal(view.description, job.snippet); assert.equal(view.title, job.title); assert.equal(view.employer, level === 'L6' ? job.company : employer); assert.equal(view.postedBy, job.company);
        }
      });
    },
  },
  {
    name: 'official-posting missing text refetches only its stored official URL once, accepts only the exact hash and restores the content-addressed text',
    async run() {
      await withStore(async ({ store, root }) => {
        const job = row(); const record = await store.save(job, { officialPosting: posting(), description: TEXT });
        await fs.unlink(textPath(root, record.officialPosting.contentHash));
        let calls = 0;
        const refetch = async url => { calls += 1; assert.equal(url, record.officialPosting.sourceUrl); await Promise.resolve(); return { description: TEXT }; };
        const bound = { ...job, officialPosting: { ...record.officialPosting, sourceUrl: 'https://forged.example/jobs/999' } };
        const views = await Promise.all([officialPostingView(bound, { store, refetch }), officialPostingView(bound, { store, refetch })]);
        assert.ok(views.every(view => view.description === TEXT)); assert.equal(calls, 1);
        assert.equal(await store.readText(record.officialPosting.contentHash), TEXT);
        assert.equal((await officialPostingView(bound, { store, refetch })).description, TEXT); assert.equal(calls, 1);
      });
    },
  },
  {
    name: 'official-posting changed or corrupt text falls back visibly, persists its enum trail and cannot cause repeated or corruption-driven refetches',
    async run() {
      for (const corrupt of [false, true]) await withStore(async ({ store, root }) => {
        const job = row(); const record = await store.save(job, { officialPosting: posting(), description: TEXT });
        const file = textPath(root, record.officialPosting.contentHash);
        if (corrupt) await fs.writeFile(file, 'Changed text with a different hash.', 'utf8'); else await fs.unlink(file);
        let calls = 0; const refetch = async () => { calls += 1; return `${TEXT} Changed.`; };
        const bound = { ...job, officialPosting: record.officialPosting };
        const first = await officialPostingView(bound, { store, refetch });
        assert.equal(first.description, job.snippet); assert.ok(first.officialPosting.trail.includes('official-text-missing'));
        assert.ok((await store.find(job)).officialPosting.trail.includes('official-text-missing'));
        assert.equal((await officialPostingView(bound, { store, refetch })).description, job.snippet);
        assert.equal(calls, corrupt ? 0 : 1);
      });
    },
  },
  {
    name: 'official-posting old missing-text refetch restores only its bytes and cannot overwrite a concurrently reverified resolution',
    async run() {
      await withStore(async ({ store, root }) => {
        const job = row(); const old = await store.save(job, { officialPosting: posting(), description: TEXT });
        await fs.unlink(textPath(root, old.officialPosting.contentHash));
        const began = deferred(); const release = deferred();
        const viewing = officialPostingView({ ...job, officialPosting: old.officialPosting }, { store, refetch: async () => {
          began.resolve(); await release.promise; return TEXT;
        } });
        await began.promise;
        const newerText = `${TEXT} The current posting includes an updated description.`;
        const current = await store.save(job, { officialPosting: posting({ trail: ['reverified'] }), description: newerText });
        release.resolve();
        assert.equal((await viewing).description, TEXT, 'the in-flight view remains bound to the record it read');
        assert.deepEqual(await store.find(job), current, 'restoring old text never rewrites current aliases or metadata');
        assert.equal(await store.readText(old.officialPosting.contentHash), TEXT);
        assert.equal(await store.readText(current.officialPosting.contentHash), newerText);
      });
    },
  },
  {
    name: 'official-posting missing-text trail compares the whole prior record so a newer same-hash proof upgrade survives',
    async run() {
      await withStore(async ({ store, root }) => {
        const job = row(); const old = await store.save(job, { officialPosting: posting({ level: 'L3' }), description: TEXT });
        await fs.unlink(textPath(root, old.officialPosting.contentHash));
        const began = deferred(); const release = deferred();
        const delayed = { ...store, save: async (savedJob, payload) => {
          assert.deepEqual(payload.expectedRecord, old);
          began.resolve(); await release.promise;
          return store.save(savedJob, payload);
        } };
        const viewing = officialPostingView({ ...job, officialPosting: old.officialPosting }, { store: delayed });
        await began.promise;
        const current = await store.save(job, { officialPosting: posting({ level: 'L2', trail: ['careers-page', 'reverified'] }), description: TEXT });
        assert.equal(current.officialPosting.contentHash, old.officialPosting.contentHash);
        release.resolve();
        assert.equal((await viewing).description, job.snippet);
        assert.deepEqual(await store.find(job), current, 'old missing-text feedback cannot erase a newer same-hash level/proof change');
        const stale = await store.save(job, { officialPosting: { ...old.officialPosting, trail: ['official-text-missing'] }, expectedRecord: old });
        assert.equal(stale, null);
        assert.deepEqual(await store.find(job), current);
      });
    },
  },
  {
    name: 'official-posting storage rejects unsafe paths, symlinked roots, alias records and text without reading or overwriting their targets',
    async run() {
      await withStore(async ({ store, root, parent }) => {
        const job = row(); const record = await store.save(job, { officialPosting: posting(), description: TEXT });
        const outside = path.join(parent, 'outside.txt'); await fs.writeFile(outside, 'Outside sentinel.', 'utf8');
        const file = textPath(root, record.officialPosting.contentHash); await fs.unlink(file); await fs.symlink(outside, file);
        await assert.rejects(store.readText(record.officialPosting.contentHash));
        await assert.rejects(store.save(job, { officialPosting: posting(), description: TEXT }));
        let calls = 0; const view = await officialPostingView({ ...job, officialPosting: record.officialPosting }, { store, refetch: async () => { calls += 1; return TEXT; } });
        assert.equal(view.description, job.snippet); assert.equal(calls, 0); assert.equal(await fs.readFile(outside, 'utf8'), 'Outside sentinel.');
        const alias = officialPostingAliases(job)[0]; const aliasPath = path.join(root, 'aliases', `${sha256(alias)}.json`);
        await fs.unlink(aliasPath); await fs.symlink(outside, aliasPath); await assert.rejects(store.find(job));
        const unsafeRoot = path.join(parent, 'linked-store'); await fs.symlink(root, unsafeRoot);
        await assert.rejects(createOfficialPostingStore(unsafeRoot).find(job));
        await assert.rejects(store.readText('../outside'));
      });
    },
  },
  {
    name: 'official-posting storage rejects invalid metadata, mismatched hashes, oversize or hostile text and empty identities without clipping',
    async run() {
      await withStore(async ({ store }) => {
        const job = row();
        await assert.rejects(store.save(job, { officialPosting: { ...posting(), invented: true }, description: TEXT }));
        await assert.rejects(store.save(job, { officialPosting: posting({ contentHash: 'f'.repeat(64) }), description: TEXT }));
        await assert.rejects(store.save(job, { officialPosting: posting(), description: 'Text\u0000with a control.' }));
        await assert.rejects(store.save(job, { officialPosting: posting(), description: 'x'.repeat(3 * 1024 * 1024 + 1) }));
        await assert.rejects(store.save({}, { officialPosting: posting(), description: TEXT }));
        assert.deepEqual(officialPostingAliases({}), []);
        assert.equal(await store.find(job), null);
      });
    },
  },
];
