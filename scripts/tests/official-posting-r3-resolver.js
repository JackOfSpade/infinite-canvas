import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import {
  createOfficialPostingRowBudget, resolveOfficialPosting, shouldPersistOfficialPostingResult,
} from '../../electron/ipc/officialPostingResolver.js';
import { createOfficialPostingStore } from '../../electron/ipc/officialPostingStore.js';

const EMPLOYER = 'Northwind Labs';
const DESCRIPTION = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
const row = (extra = {}) => ({ title: 'Software Engineer', company: EMPLOYER, location: 'Lakeview, Ontario, Canada',
  snippet: DESCRIPTION, url: 'https://www.linkedin.com/jobs/view/synthetic-r3', ...extra });
const miss = (trail = [], extra = {}) => ({ level: 'L5', outcome: 'not-found', employer: EMPLOYER, trail, ...extra });
const verified = (trail = []) => ({ level: 'L4', outcome: 'link-only', employer: EMPLOYER,
  sourceUrl: 'https://northwind.test/jobs/one', officialApplyUrl: 'https://northwind.test/jobs/one', trail });
const error = code => Object.assign(new Error(code), { code });
const html = (body, url) => ({ body, url, sourceUrl: url, contentType: 'text/html', statusCode: 200 });
const posting = (url, extra = {}) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
  title: 'Software Engineer', hiringOrganization: { name: EMPLOYER }, identifier: 'req-one', description: DESCRIPTION, url,
  jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, ...extra })}</script>`;
function network(pages, requests = []) {
  return async url => {
    requests.push(url);
    if (!(url in pages)) throw error('closed');
    return typeof pages[url] === 'string' ? html(pages[url], url) : { url, sourceUrl: url, statusCode: 200, ...pages[url] };
  };
}
function memoryStore() {
  const saved = [];
  return { saved, find: async () => null, save: async (job, record) => { saved.push({ job, ...record }); return record; } };
}

export default [
  {
    name: 'R3 shared run cancellation uses one bounded fanout listener and disposes every row budget',
    run() {
      const run = new AbortController();
      const budgets = Array.from({ length: 250 }, () => createOfficialPostingRowBudget({ signal: run.signal }));
      assert.equal(getEventListeners(run.signal, 'abort').length, 1);
      run.abort(error('NodeDeleted'));
      assert.ok(budgets.every(budget => budget.signal.aborted && budget.signal.reason.code === 'NodeDeleted'));
      for (const budget of budgets) budget.dispose();
      assert.equal(getEventListeners(run.signal, 'abort').length, 0);
      const next = new AbortController(); const unused = createOfficialPostingRowBudget({ signal: next.signal });
      unused.dispose(); assert.equal(getEventListeners(next.signal, 'abort').length, 0);
      const replacement = createOfficialPostingRowBudget({ signal: next.signal }); unused.dispose();
      assert.equal(getEventListeners(next.signal, 'abort').length, 1, 'disposal is idempotent across fanout generations');
      replacement.dispose(); assert.equal(getEventListeners(next.signal, 'abort').length, 0);
    },
  },
  {
    name: 'R3 miss durability requires clean research or definitive checks and always refuses an aborted signal',
    run() {
      assert.equal(shouldPersistOfficialPostingResult(miss()), false);
      assert.equal(shouldPersistOfficialPostingResult(miss(), { researchRan: true }), true);
      for (const trail of [['bridge-research'], ['closed'], ['title-mismatch'], ['ambiguous']]) {
        assert.equal(shouldPersistOfficialPostingResult({ posting: miss(trail) }), true);
      }
      for (const code of ['bridge-aborted', 'bridge-timeout', 'bridge-unavailable', 'research-miss', 'fetch-failed', 'fetch-timeout', 'crawl-budget', 'failed']) {
        assert.equal(shouldPersistOfficialPostingResult(miss(['bridge-research', 'closed', code]), { researchRan: true }), false, code);
        assert.equal(shouldPersistOfficialPostingResult({ officialPosting: verified([code]) }), true, `verified survives incidental ${code}`);
      }
      for (const code of ['unreadable', 'oversize', 'unsafe-url', 'unsafe-address', 'unsupported-content-type', 'invalid-text']) {
        assert.equal(shouldPersistOfficialPostingResult(miss([code])), false, `a partial free pass is not definitive: ${code}`);
      }
      const controller = new AbortController(); controller.abort(error('bridge-aborted'));
      assert.equal(shouldPersistOfficialPostingResult(verified(), { signal: controller.signal }), false);
      assert.equal(shouldPersistOfficialPostingResult(miss(['closed']), { signal: controller.signal, researchRan: true }), false);
      assert.equal(shouldPersistOfficialPostingResult(miss(['closed'], { outcome: 'failed' })), false);
    },
  },
  {
    name: 'R3 standalone resolver never writes a transient fetch bridge stop or malformed-research miss',
    async run() {
      for (const code of ['fetch-failed', 'fetch-timeout']) {
        const store = memoryStore();
        const result = await resolveOfficialPosting(row({ url: 'https://northwind.test/jobs/one' }), {
          store, fetch: async () => { throw error(code); }, research: async () => [],
        });
        assert.ok(result.officialPosting.trail.includes(code)); assert.equal(store.saved.length, 0, code);
      }
      for (const code of ['bridge-unavailable', 'bridge-timeout', 'bridge-aborted', 'research-miss']) {
        const store = memoryStore();
        await resolveOfficialPosting(row(), { store, research: async () => { throw error(code); } });
        assert.equal(store.saved.length, 0, code);
      }
      const store = memoryStore(); const controller = new AbortController();
      await resolveOfficialPosting(row({ url: 'https://northwind.test/jobs/one' }), {
        store, signal: controller.signal, fetch: async () => { controller.abort(error('NodeDeleted')); throw error('closed'); },
      });
      assert.equal(store.saved.length, 0, 'a closed-looking response after Stop is not durable');
      const reused = createOfficialPostingRowBudget(); const later = new AbortController();
      try {
        await resolveOfficialPosting(row({ url: 'https://northwind.test/jobs/one' }), {
          store, rowBudget: reused, signal: later.signal,
          fetch: async () => { later.abort(error('NodeDeleted')); throw error('closed'); },
        });
        assert.equal(reused.signal.aborted, true, 'a caller signal also binds a pre-created budget');
        assert.equal(store.saved.length, 0);
      } finally { reused.dispose(); }
      await resolveOfficialPosting(row(), { store, research: async () => ({ invalid: true }) });
      assert.equal(store.saved.length, 0, 'only a validated research array counts as research having run');
      await resolveOfficialPosting(row(), { store });
      assert.equal(store.saved.length, 0, 'no free leads is not a definitive miss');
    },
  },
  {
    name: 'R3 standalone resolver persists clean NOT FOUND and definitive host failure but service can own all writes',
    async run() {
      const clean = memoryStore();
      await resolveOfficialPosting(row(), { store: clean, research: async () => [] });
      assert.equal(clean.saved.length, 1); assert.ok(clean.saved[0].officialPosting.trail.includes('bridge-research'));
      const closed = memoryStore();
      await resolveOfficialPosting(row({ url: 'https://northwind.test/jobs/closed' }), {
        store: closed, fetch: async () => { throw error('closed'); },
      });
      assert.equal(closed.saved.length, 1);
      const delegated = memoryStore();
      await resolveOfficialPosting(row(), { store: delegated, persistResults: false, research: async () => [] });
      assert.equal(delegated.saved.length, 0);
      const url = 'https://northwind.test/jobs/one';
      const found = await resolveOfficialPosting(row({ url }), { store: delegated, persistResults: false,
        fetch: network({ 'https://northwind.test/': `<title>${EMPLOYER}</title>`, [url]: posting(url) }) });
      assert.equal(found.officialPosting.level, 'L1'); assert.equal(delegated.saved.length, 0);
    },
  },
  {
    name: 'R3 historical transient misses retry while clean settled misses and verified results remain reusable',
    async run() {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'official-r3-cache-'));
      try {
        const job = row(); const store = createOfficialPostingStore(directory);
        for (const code of ['bridge-aborted', 'bridge-timeout', 'bridge-unavailable', 'fetch-failed', 'fetch-timeout', 'research-miss']) {
          await store.save(job, { officialPosting: miss(['bridge-research', code]) });
          let researches = 0;
          const result = await resolveOfficialPosting(job, { store, research: async () => { researches++; return []; } });
          assert.equal(researches, 1, `historical ${code} must not suppress retry`);
          assert.ok(!result.officialPosting.trail.includes('recent-miss'));
        }
        await store.save(job, { officialPosting: miss(['bridge-research']) });
        const settled = await resolveOfficialPosting(job, { store, research: async () => { throw new Error('unexpected research'); } });
        assert.ok(settled.officialPosting.trail.includes('recent-miss'));
        await store.save(job, { officialPosting: verified(['fetch-failed']) });
        const cached = await resolveOfficialPosting(job, { store, fetch: async () => { throw new Error('unexpected fetch'); } });
        assert.equal(cached.officialPosting.level, 'L4'); assert.ok(cached.officialPosting.trail.includes('cache-hit'));
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    },
  },
  {
    name: 'R3 crawl skips script bytes static assets auth paths and repeated locales while retaining script tenant detection',
    async run() {
      const requests = []; const lever = 'https://api.lever.co/v0/postings/northwind?mode=json';
      const utilities = ['Login', 'Register', 'ResetPassword', 'RegistrationMethods', 'JobApplication', 'privacy-policy', 'cookie_policy', 'terms-of-service'];
      const links = [
        ...Array.from({ length: 12 }, (_, i) => `<script src="https://northwind.test/assets/chunk-${i}.js"></script>`),
        '<script src="https://jobs.lever.co/northwind/bundle.js"></script>',
        ...utilities.flatMap(part => ['en_US', 'fr_CA'].map(locale => `<a href="/${locale}/careers/${part}">${part}</a>`)),
        '<a href="/jobs/style.css">Styles</a>',
        ...['en_US', 'fr_CA', 'de_DE', 'zh-Hant'].map(locale => `<a href="/${locale}/jobs/open">Open</a>`),
        '<a href="/jobs/open">Default locale</a>',
        '<a href="/jobs/query?lang=en">Query</a><a href="/jobs/query?lang=fr">Query</a>',
      ].join('');
      await resolveOfficialPosting(row(), { candidateUrls: ['https://northwind.test/careers'], fetch: network({
        'https://northwind.test/': `<title>${EMPLOYER}</title>`, 'https://northwind.test/careers': links,
        'https://northwind.test/en_US/jobs/open': '<main>No matching role</main>',
        'https://northwind.test/jobs/query?lang=en': '<main>No matching role</main>',
        [lever]: { contentType: 'application/json', body: '[]' },
      }, requests) });
      assert.ok(requests.includes(lever), 'a script tenant still enables its host-owned board adapter');
      assert.ok(requests.includes('https://northwind.test/en_US/jobs/open'));
      assert.ok(requests.includes('https://northwind.test/jobs/query?lang=en'));
      assert.ok(!requests.includes('https://northwind.test/jobs/open'));
      assert.ok(!requests.some(url => /\.js|\.css|fr_CA|de_DE|zh-Hant|lang=fr|Login|Register|ResetPassword|RegistrationMethods|JobApplication|privacy|cookie|terms/iu.test(url)), requests.join('\n'));
    },
  },
  {
    name: 'R3 final URL caches never turn a cross-host redirect origin into independent employer root proof',
    async run() {
      const root = 'https://northwind.test/'; const board = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
      const rootBody = `<title>${EMPLOYER}</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a>`;
      const pages = { [root]: rootBody, 'https://jobs.ashbyhq.com/northwind': '<main>Open roles</main>',
        [board]: { contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: 'req-one', title: 'Software Engineer',
          location: 'Lakeview, Ontario, Canada', jobUrl: 'https://jobs.ashbyhq.com/northwind/req-one',
          descriptionPlain: DESCRIPTION, isListed: true }] }) } };
      const redirected = { ...pages, [root]: { ...html(rootBody, root), requestedUrl: 'https://gateway.test/' },
        'https://gateway.test/': { ...html(rootBody, root), requestedUrl: 'https://gateway.test/' } };
      const rejected = await resolveOfficialPosting(row(), { fetch: network(redirected), candidateUrls: ['https://gateway.test/'] });
      assert.equal(rejected.officialPosting.level, 'L5'); assert.equal(rejected.officialPosting.officialApplyUrl, undefined);
      const independent = await resolveOfficialPosting(row(), { fetch: network(pages), candidateUrls: [root] });
      assert.equal(independent.officialPosting.level, 'L2');
    },
  },
  {
    name: 'R3 round-trip ownership is re-evaluated after later pages are read so lead order cannot change the result',
    async run() {
      const tenantPosting = 'https://jobs.ashbyhq.com/northwind/req-one'; const root = 'https://northwindhq.test/'; const careers = `${root}careers`;
      const site = ({ rootTitle = `${EMPLOYER} \u2013 The workflow platform for regional dispatch`, careersLink = true } = {}) => ({
        [root]: `<title>${rootTitle}</title><p>Welcome to our platform.</p>`,
        [careers]: `<title>Join the team</title>${careersLink ? `<a href="https://jobs.ashbyhq.com/northwind">Open roles</a><a href="${tenantPosting}">Software Engineer</a>` : '<p>No openings listed.</p>'}`,
        'https://jobs.ashbyhq.com/northwind': '<main>Open roles</main>',
        [tenantPosting]: posting(tenantPosting, { hiringOrganization: { name: EMPLOYER, sameAs: root } }),
      });
      const resolve = (pages, leads) => resolveOfficialPosting(row({ identifier: 'req-one' }), { fetch: network(pages), candidateUrls: leads });
      // The posting is read before the page that links to it. Its first attempt at the round trip has nothing to prove with.
      for (const leads of [[tenantPosting, careers], [careers, tenantPosting]]) {
        const result = await resolve(site(), leads);
        assert.equal(result.officialPosting.level, 'L2', `${leads.map(url => url.split('/').pop())}: ${JSON.stringify(result.officialPosting.trail)}`);
        assert.equal(result.officialPosting.sourceUrl, tenantPosting); assert.equal(result.officialPosting.employer, EMPLOYER);
        assert.ok(result.officialPosting.trail.includes('domain-proof'));
      }
      // Re-evaluation adds evidence, never leniency: a wrong brand, or a careers page that never links the tenant, still proves nothing.
      for (const pages of [site({ rootTitle: 'Unrelated Group \u2013 Marketing' }), site({ careersLink: false })]) {
        for (const leads of [[tenantPosting, careers], [careers, tenantPosting]]) {
          const result = await resolve(pages, leads);
          assert.equal(result.officialPosting.level, 'L5'); assert.equal(result.officialPosting.sourceUrl, undefined);
          assert.ok(result.officialPosting.trail.includes('tenant-unproven'), JSON.stringify(result.officialPosting.trail));
        }
      }
    },
  },
  {
    name: 'R3 standalone resolver stores a verified result when only its own host budget ran out and never after a run stop',
    async run() {
      const url = 'https://northwind.test/jobs/one'; const apply = 'https://northwind.test/apply/one';
      const base = network({ 'https://northwind.test/': `<title>${EMPLOYER}</title>`, [url]: posting(url), [apply]: '<main>Apply</main>' });
      const lead = row({ url, applyOptions: [{ label: 'Posting', href: url }, { label: 'Apply', href: apply }] });
      let clock = 0; const store = memoryStore(); const budget = createOfficialPostingRowBudget({ timeoutMs: 10, now: () => clock });
      try {
        const result = await resolveOfficialPosting(lead, { store, rowBudget: budget, fetch: async target => { if (target === url) clock += 20; return base(target); } });
        assert.equal(result.officialPosting.level, 'L1'); assert.equal(budget.signal.reason.code, 'fetch-timeout');
        assert.ok(result.officialPosting.trail.includes('fetch-timeout'));
        assert.equal(store.saved.length, 1, 'a verified match survives the incidental end of its own crawl budget');
      } finally { budget.dispose(); }
      const stopped = memoryStore(); const run = new AbortController();
      const result = await resolveOfficialPosting(lead, { store: stopped, signal: run.signal,
        fetch: async target => { if (target === apply) run.abort(error('NodeDeleted')); return base(target); } });
      assert.equal(result.officialPosting.level, 'L1'); assert.equal(stopped.saved.length, 0, 'a stopped run never writes');
    },
  },
  {
    name: 'R3 crawl follows at most eight eligible links from one page',
    async run() {
      const requests = []; const pages = { 'https://northwind.test/': `<title>${EMPLOYER}</title>`,
        'https://northwind.test/careers': Array.from({ length: 12 }, (_, i) => `<a href="/jobs/${i}">Role</a>`).join('') };
      for (let i = 0; i < 12; i++) pages[`https://northwind.test/jobs/${i}`] = '<main>No matching role</main>';
      await resolveOfficialPosting(row(), { candidateUrls: ['https://northwind.test/careers'], fetch: network(pages, requests) });
      assert.equal(requests.filter(url => /\/jobs\/\d+$/u.test(url)).length, 8);
      assert.ok(!requests.includes('https://northwind.test/jobs/8'));
    },
  },
  {
    name: 'R3 shared row budget counts roots adapters and unique reads once across both passes and stops at sixteen',
    async run() {
      const requests = []; const store = memoryStore(); const budget = createOfficialPostingRowBudget();
      const pages = { 'https://northwind.test/': `<title>${EMPLOYER}</title>` };
      for (let i = 0; i < 24; i++) pages[`https://northwind.test/jobs/${i}`] = '<main>No matching role</main>';
      try {
        const fetch = network(pages, requests);
        await resolveOfficialPosting(row(), { store, rowBudget: budget, fetch,
          candidateUrls: Array.from({ length: 12 }, (_, i) => `https://northwind.test/jobs/${i}`) });
        const second = await resolveOfficialPosting(row(), { store, rowBudget: budget, fetch, bypassCache: true,
          candidateUrls: Array.from({ length: 24 }, (_, i) => `https://northwind.test/jobs/${i}`) });
        assert.equal(requests.length, 16); assert.equal(new Set(requests).size, 16);
        assert.equal(requests.filter(url => url === 'https://northwind.test/').length, 1);
        assert.equal(budget.signal.reason.code, 'crawl-budget');
        assert.ok(second.officialPosting.trail.includes('crawl-budget')); assert.equal(store.saved.length, 0);
      } finally { budget.dispose(); }
      const capped = createOfficialPostingRowBudget({ maxPages: 2 }); const adapterRequests = [];
      try {
        const root = 'https://northwind.test/';
        await resolveOfficialPosting(row(), { rowBudget: capped, candidateUrls: [root], fetch: network({
          [root]: `<title>${EMPLOYER}</title><a href="https://jobs.ashbyhq.com/northwind">Open</a>`,
          'https://jobs.ashbyhq.com/northwind': '<main>Open roles</main>',
        }, adapterRequests) });
        assert.deepEqual(adapterRequests, [root, 'https://jobs.ashbyhq.com/northwind']);
        assert.equal(capped.signal.reason.code, 'crawl-budget', 'the board adapter is subject to the same page cap');
      } finally { capped.dispose(); }
    },
  },
  {
    name: 'R3 cumulative host time excludes handoff wait and aborts a stalled fetch without persisting it',
    async run() {
      let clock = 0; const requests = []; const budget = createOfficialPostingRowBudget({ timeoutMs: 10, now: () => clock });
      try {
        const fetch = async url => { requests.push(url); clock += 6; return html(`<title>${EMPLOYER}</title>`, url); };
        await resolveOfficialPosting(row(), { rowBudget: budget, fetch, candidateUrls: ['https://northwind.test/'] });
        assert.equal(budget.signal.aborted, false);
        clock += 1_000_000;
        const second = await resolveOfficialPosting(row(), { rowBudget: budget, fetch, candidateUrls: ['https://northwind.test/jobs/one'] });
        assert.equal(requests.length, 2, 'the handoff gap does not consume the remaining host time');
        assert.equal(budget.signal.reason.code, 'fetch-timeout'); assert.ok(second.officialPosting.trail.includes('fetch-timeout'));
      } finally { budget.dispose(); }
      const stalled = createOfficialPostingRowBudget({ timeoutMs: 30 }); const store = memoryStore(); const started = Date.now();
      try {
        const result = await resolveOfficialPosting(row(), { store, rowBudget: stalled, candidateUrls: ['https://northwind.test/'],
          fetch: async () => new Promise(() => {}) });
        assert.ok(Date.now() - started < 500, 'even an injected fetch that ignores abort cannot hold the resolver');
        assert.ok(result.officialPosting.trail.includes('fetch-timeout')); assert.equal(store.saved.length, 0);
      } finally { stalled.dispose(); }
    },
  },
  {
    name: 'R3 Teamtailor RSS filters unrelated titles and cities before spending the shared page budget',
    async run() {
      const root = 'https://careers.northwind.test/'; const wanted = `${root}jobs/wanted`; const requests = [];
      const item = (id, title, city) => `<item><title>${title}</title><link>${root}jobs/${id}</link><guid>${id}</guid><description><![CDATA[${DESCRIPTION}]]></description><tt:locations><tt:location><tt:city>${city}</tt:city><tt:country>Canada</tt:country></tt:location></tt:locations></item>`;
      const irrelevant = Array.from({ length: 50 }, (_, i) => item(`designer-${i}`, 'Product Designer', 'Lakeview'))
        .concat(Array.from({ length: 50 }, (_, i) => item(`other-city-${i}`, 'Software Engineer', 'Riverton')));
      const feed = `<rss xmlns:tt="https://teamtailor.com/locations"><channel>${irrelevant.join('')}${item('wanted', 'Software Engineer', 'Lakeview')}</channel></rss>`;
      const pages = { [root]: `<title>${EMPLOYER}</title><footer>Powered by Teamtailor</footer>`,
        [`${root}jobs.rss`]: { body: feed, contentType: 'application/rss+xml' },
        [wanted]: `${posting(wanted, { identifier: 'wanted', description: 'A brief role summary.' })}<footer>Powered by Teamtailor</footer>` };
      const result = await resolveOfficialPosting(row({ title: `Software Engineer at ${EMPLOYER}`, identifier: 'wanted' }), {
        fetch: network(pages, requests), candidateUrls: [root],
      });
      assert.equal(result.officialPosting.level, 'L2'); assert.equal(result.officialPosting.sourceUrl, wanted);
      assert.equal(result.description, DESCRIPTION); assert.deepEqual(requests, [root, `${root}jobs.rss`, wanted]);
      const peerRequests = [];
      const noIndependentAnchor = await resolveOfficialPosting(row(), { fetch: network(pages, peerRequests), candidateUrls: [root] });
      assert.equal(noIndependentAnchor.officialPosting.level, 'L5', 'unvisited city/title peers still suppress shared board copy');
      assert.ok(noIndependentAnchor.officialPosting.trail.includes('no-anchor'));
      assert.deepEqual(peerRequests, [root, `${root}jobs.rss`, wanted]);
    },
  },
];
