import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import {
  createOfficialPostingRowBudget, resolveOfficialPosting, shouldPersistOfficialPostingResult,
} from '../../electron/ipc/officialPostingResolver.js';
import { createOfficialPostingStore, officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';
import { buildOfficialPostingMatchRequest } from '../../electron/ipc/officialPostingBridge.js';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import { readOfficialExpiryCandidates } from '../../electron/ipc/listingLivenessStore.js';
import { officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';

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

const COMPARATIVE_SCRAPED = [
  'This position orchestrates evening freight assignments for regional distribution centers while recording unusual delivery conditions.',
  'Our vacancy coordinates transfer procedures linking storage supervisors with contracted transportation providers throughout supply networks.',
  'Successful applicants improve asynchronous monitoring infrastructure and diagnose record discrepancies through repeatable verification scenarios.',
];
const COMPARATIVE_OFFICIAL = [
  'You will direct nightly route allocation across coastal depots and document dispatch exceptions for operations.',
  'The scheduling group owns shipment handoffs between warehouse coordinators and third party fleet carriers.',
  'Engineers maintain event driven telemetry pipelines and investigate data consistency failures using reproducible test cases.',
];
const COMPARATIVE_SIBLING = [
  'The billing team reconciles monthly invoice adjustments across retail accounts and publishes accurate revenue ledgers.',
  'Financial analysts coordinate payment settlements between procurement administrators and external auditing partners for quarterly reporting.',
  'Developers operate currency conversion services and inspect transaction disputes through documented accounting review procedures.',
];
const comparisonRow = extra => row({ sourceJobKey: 'comparative-synthetic-row', snippet: `Requirements: ${COMPARATIVE_SCRAPED.join(' ')}`, ...extra });
function comparisonFixture(specs = [{ id: 'one' }]) {
  const quotes = new Map();
  const pages = { 'https://northwind.test/': `<title>${EMPLOYER}</title>` };
  for (const spec of specs) {
    const url = `https://northwind.test/jobs/${spec.id}`;
    const lines = spec.quotes || COMPARATIVE_OFFICIAL;
    quotes.set(url, lines);
    pages[url] = posting(url, { identifier: `request-${spec.id}`, description: `Requirements: ${lines.join(' ')}`,
      ...(spec.closed ? { validThrough: '2000-01-01T00:00:00Z' } : {}),
      ...(spec.city ? { jobLocation: { address: { addressLocality: spec.city, addressRegion: 'Ontario', addressCountry: 'Canada' } } } : {}),
      ...(spec.title ? { title: spec.title } : {}), ...(spec.extra || {}) });
  }
  return { fetch: network(pages), candidateUrls: [...quotes.keys()], quotes };
}
function comparisonAnswer(options, fixture, selected = options[0]?.id) {
  if (selected === 'none') return { choice: 'none', evidence: [], distinguishing: [], conflicts: [] };
  const chosen = options.find(option => option.id === selected);
  const quotes = fixture.quotes.get(chosen.candidate.sourceUrl);
  return { choice: chosen.id, evidence: quotes.map((quote, index) => ({ scrapedQuote: COMPARATIVE_SCRAPED[index], officialQuote: quote })),
    distinguishing: options.filter(option => option.id !== chosen.id && option.status === 'live').map(option => ({
      optionId: option.id, officialQuote: quotes[0], reason: 'The chosen posting describes a different operating team and scope.' })), conflicts: [] };
}

export { COMPARATIVE_SCRAPED, COMPARATIVE_OFFICIAL, COMPARATIVE_SIBLING, comparisonRow, comparisonFixture, comparisonAnswer };

async function hiddenContradictionScenario(kind) {
  const shared = DESCRIPTION.split(/(?<=\.)\s+/u);
  const trueTeam = 'Team: Payments Platform. You will own the settlement services for the payments platform group and its on call rotation.';
  const wrongTeam = 'Team: Risk Engineering. You will own the fraud scoring services for the risk engineering group and its on call rotation.';
  const recruiter = 'Recruiters note that the candidate will join a friendly group.';
  const hiddenText = `${trueTeam} HIDDEN SOURCE ONLY: This separate historical description records a different operating scope. ${shared.join(' ')}`;
  const wrongText = `${wrongTeam} ${shared.join(' ')} Visible scope zero owns regional review procedures.`;
  const salary = { '@type': 'MonetaryAmount', currency: 'CAD', value: { '@type': 'QuantitativeValue', minValue: 130000, maxValue: 150000, unitText: 'YEAR' } };
  const wrongSpecs = Array.from({ length: kind === 'cap' ? 8 : 1 }, (_, index) => ({ id: `visible-${index}`,
    extra: { identifier: kind === 'collapse' ? 'request-shared' : `visible-request-${index}`,
      description: index ? `${wrongTeam} ${shared.join(' ')} Visible scope ${index} owns separate regional review procedures.` : wrongText } }));
  const fixture = comparisonFixture([{ id: 'hidden', extra: { identifier: kind === 'collapse' ? 'request-shared' : 'hidden-request',
    description: kind === 'pay' ? hiddenText : `${trueTeam} HIDDEN SOURCE ONLY: Separate operating requirements. ${'Distinct budgeting documentation for auditing colleagues. '.repeat(35)}`,
    ...(kind === 'pay' ? { baseSalary: salary } : {}) } }, ...wrongSpecs]);
  const input = comparisonRow({ snippet: `${trueTeam} ${recruiter} ${shared[0]} Occasional travel may be needed. ${shared[4]} Mentoring newer colleagues is encouraged.`,
    ...(kind === 'pay' ? { salary: 'CAD 120000-140000 YEAR', salaryProvenance: 'posted' } : {}) });
  const calls = [];
  const result = await resolveOfficialPosting(input, { ...fixture, researchRan: true,
    match: async (job, options, context) => {
      const chosen = options.find(option => option.candidate.sourceUrl.endsWith('/visible-0'));
      const distinctive = `${shared[4]} Visible scope zero owns regional review procedures.`;
      const answer = { choice: chosen.id, conflicts: [], evidence: [
        { scrapedQuote: shared[0], officialQuote: shared[0] }, { scrapedQuote: shared[4], officialQuote: distinctive },
        { scrapedQuote: recruiter, officialQuote: wrongTeam } ],
      distinguishing: options.filter(option => option !== chosen && option.status === 'live').map(option => ({
        optionId: option.id, officialQuote: 'Visible scope zero', reason: 'The visible scope differs.' })) };
      calls.push({ options, context, answer, request: buildOfficialPostingMatchRequest({ job, options, ...context }) });
      return answer;
    } });
  assert.equal(result.officialPosting.outcome, 'not-found');
  assert.ok(result.officialPosting.trail.includes('comparative-invalid'));
  assert.equal(calls.length, 4, 'both invalid independent runs receive one correction');
  for (const call of calls) {
    assert.equal(call.options.length, kind === 'cap' ? 8 : 1);
    assert.ok(call.context.contradictionOnly.some(option => option.candidate.sourceUrl.endsWith('/hidden')));
    assert.ok(call.options.every(option => !option.candidate.sourceUrl.endsWith('/hidden')));
    const visible = JSON.parse(call.request.prompt.split('BEGIN UNTRUSTED POSTING COMPARISON JSON\n')[1].split('\nEND UNTRUSTED POSTING COMPARISON JSON')[0]).options;
    assert.equal(JSON.stringify(visible).includes('HIDDEN SOURCE ONLY'), false);
    const withoutHidden = buildOfficialPostingMatchRequest({ job: input, options: call.options, ...call.context, contradictionOnly: [] });
    assert.equal(call.request.prompt, withoutHidden.prompt);
    assert.deepEqual(call.request.responseSchema, withoutHidden.responseSchema);
    assert.deepEqual(call.request.manualHandoff, withoutHidden.manualHandoff, 'host-only contradiction data never enters prompts, schemas or comparison-group digests');
    assert.throws(() => call.request.responseValidator(call.answer), error => error.correctionRuleIds?.includes('LOOKUP_OFFICIAL_MATCH_DISTINCTIVE'));
  }
}

export default [
  {
    name: 'official fetch diagnostics clear an inherited redirect-hop failure after the hop succeeds through its URL or a new redirect',
    async run() {
      const original = 'https://careers.northwind.example/redirect';
      const final = 'https://careers.northwind.example/jobs/one';
      const alias = 'https://careers.northwind.example/current';
      for (const recoveredUrl of [final, alias]) {
        const first = createOfficialPostingRowBudget();
        let second;
        const reads = [];
        const fetch = async url => {
          reads.push(url);
          if (url === original) throw Object.assign(error('fetch-failed'), { statusCode: 503, url: final });
          return html('<html><title>Northwind Labs</title><body>Careers</body></html>', url === recoveredUrl ? final : url);
        };
        try {
          const initial = await resolveOfficialPosting(row(), { fetch, rowBudget: first, candidateUrls: [original],
            researchRan: true, bypassCache: true, semanticMatching: false, persistResults: false });
          assert.deepEqual(initial.officialPosting.fetchFailures, [{ url: final, code: 'fetch-failed', reason: 'server-error', statusCode: 503 }]);
          second = createOfficialPostingRowBudget({ previous: first, retryUrls: [recoveredUrl] });
          const recovered = await resolveOfficialPosting(row(), { fetch, rowBudget: second, candidateUrls: [recoveredUrl],
            researchRan: true, bypassCache: true, semanticMatching: false, persistResults: false });
          assert.ok(reads.includes(recoveredUrl), 'the recovery read must actually succeed');
          assert.deepEqual(recovered.officialPosting.fetchFailures || [], [], 'a successful actual hop must not retain its old 503 receipt');
          const status = officialPostingLookupStatus(recovered.officialPosting);
          assert.doesNotMatch(status.label, /Employer site verification/u, 'remaining match uncertainty must not be mislabeled as a current fetch failure');
          assert.doesNotMatch(status.detail, /server error|HTTP 503/u);
          assert.equal(reads.filter(url => url === original).length, 1, 'diagnostic reconciliation does not silently refetch the original redirect');
        } finally { first.dispose(); second?.dispose(); }
      }
    },
  },
  {
    name: 'deferred expiry resolver exposes bounded candidate URLs and request-local page evidence without caching an unconfirmed miss',
    async run() {
      await __runWithIpcRequestContextForTests({ livenessEvidence: new Map() }, async () => {
        const target = row({ source: 'linkedin', jobkey: 'synthetic-expiry', identifier: 'req-one' });
        const url = 'https://northwind.test/jobs/expired';
        const store = memoryStore();
        const result = await resolveOfficialPosting(target, { store, researchRan: true,
          candidateUrls: [url], fetch: network({
            'https://northwind.test/': '<title>Northwind Labs</title>',
            [url]: `${posting(url, { validThrough: '2000-01-01T00:00:00Z' })}<h1>Software Engineer</h1><p>This job is no longer available.</p>`,
          }) });
        assert.equal(result.officialPosting.outcome, 'not-found');
        assert.deepEqual(result.expiryCandidates, [url]);
        const captured = readOfficialExpiryCandidates(target);
        assert.deepEqual(captured.map(candidate => candidate.url), [url]);
        assert.ok(captured[0].evidence.chromeText.includes('This job is no longer available.'));
        assert.equal(JSON.stringify(result).includes('This job is no longer available.'), false,
          'candidate page text stays only in request-local storage');
        assert.equal(store.saved.length, 0, 'an unconfirmed expired candidate must not become a durable settled miss');
      });
    },
  },
  {
    name: 'deferred expiry direct resolver revisits historical closed-trail cache entries without a candidate receipt',
    async run() {
      const target = row({ source: 'linkedin', jobkey: 'synthetic-legacy-expiry' });
      const url = 'https://northwind.test/jobs/legacy-expiry';
      let reads = 0;
      const result = await resolveOfficialPosting(target, { candidateUrls: [url],
        store: { find: async () => ({ aliases: officialPostingAliases(target),
          officialPosting: miss(['bridge-research', 'closed']) }) },
        fetch: async () => { reads++; throw error('fetch-failed'); } });
      assert.ok(reads > 0, 'the stale closed verdict cannot bypass the host fetch');
      assert.equal(result.officialPosting.trail.includes('recent-miss'), false);
    },
  },
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
    name: 'R3 miss durability requires current ownership discovery plus clean research and refuses legacy negatives or aborted signals',
    run() {
      assert.equal(shouldPersistOfficialPostingResult(miss()), false);
      assert.equal(shouldPersistOfficialPostingResult(miss(), { researchRan: true }), false);
      assert.equal(shouldPersistOfficialPostingResult(miss([OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL]), { researchRan: true }), true);
      for (const trail of [['bridge-research'], ['closed'], ['title-mismatch'], ['ambiguous']]) {
        assert.equal(shouldPersistOfficialPostingResult({ posting: miss(trail) }), false);
        assert.equal(shouldPersistOfficialPostingResult({ posting: miss([...trail, OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL]) }), true);
      }
      for (const code of ['bridge-aborted', 'bridge-timeout', 'bridge-unavailable', 'research-miss', 'fetch-failed', 'fetch-timeout', 'crawl-budget', 'failed']) {
        assert.equal(shouldPersistOfficialPostingResult(miss(['bridge-research', 'closed', code]), { researchRan: true }), false, code);
        assert.equal(shouldPersistOfficialPostingResult({ officialPosting: verified(['identifier-anchor', code]) }), true, `deterministically verified survives incidental ${code}`);
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
    name: 'Amendment 5 partial verified crawl durability needs an identifier anchor and old partial cache entries retry',
    async run() {
      for (const level of ['L1', 'L2', 'L3', 'L4']) for (const partial of ['fetch-timeout', 'crawl-budget', 'crawl-partial']) {
        for (const anchor of [null, 'description-anchor', 'quoted-match', 'identifier-anchor', 'salary-anchor']) {
          const value = { ...verified([partial, ...(anchor ? [anchor] : [])]), level, outcome: level === 'L4' ? 'link-only' : 'found' };
          assert.equal(shouldPersistOfficialPostingResult(value), anchor === 'identifier-anchor', `${level} / ${partial} / ${anchor}`);
          assert.equal(shouldPersistOfficialPostingResult(value, { signal: AbortSignal.abort() }), false, 'a stopped run is never durable');
        }
      }
      assert.equal(shouldPersistOfficialPostingResult(verified(['description-anchor'])), true, 'a complete crawl can retain a text match');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'official-partial-cache-'));
      try {
        const store = createOfficialPostingStore(dir);
        await store.save(row(), { officialPosting: { ...verified(['fetch-timeout', 'description-anchor']), level: 'L1', outcome: 'found' }, description: DESCRIPTION });
        const result = await resolveOfficialPosting(row(), { store, persistResults: false, fetch: async () => { throw error('closed'); } });
        assert.notEqual(result.officialPosting.level, 'L1', 'an old partial text-only record must not short-circuit fresh resolution');
        assert.ok(!result.officialPosting.trail.includes('cache-hit'));
      } finally { await fs.rm(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'Amendment 5 partial crawl tracks failed winner-site pages without charging irrelevant page timeouts to the row budget',
    async run() {
      const first = 'https://northwind.test/jobs/one'; const sibling = 'https://northwind.test/jobs/two';
      const unrelated = 'https://cedar.test/careers';
      const pages = { 'https://northwind.test/': `<title>${EMPLOYER}</title>`, [first]: posting(first) };
      for (const failed of [sibling, unrelated]) for (const code of ['fetch-failed', 'fetch-timeout']) {
        for (const before of [false, true]) {
          const store = memoryStore(); const budget = createOfficialPostingRowBudget(); const seen = [];
          try {
            const result = await resolveOfficialPosting(row(), { store, rowBudget: budget,
              candidateUrls: before ? [failed, first] : [first, failed], fetch: async url => {
                seen.push(url); if (url === failed) throw error(code); return network(pages)(url);
              } });
            assert.equal(result.officialPosting.level, 'L1');
            assert.ok(result.officialPosting.trail.includes('description-anchor'));
            assert.equal(budget.signal.aborted, false, `${code} is a page failure, not row exhaustion`);
            assert.equal(result.officialPosting.trail.includes('crawl-partial'), failed === sibling);
            assert.equal(store.saved.length, failed === sibling ? 0 : 1, `${failed} / ${code} / before=${before}`);
            if (failed === sibling) assert.ok(seen.includes(sibling), 'a discovered same-site sibling is read before settling');
          } finally { budget.dispose(); }
        }
      }
    },
  },
  {
    name: 'Amendment 5 same-tenant board failures remain partial across ATS hosts while another tenant is irrelevant',
    async run() {
      const first = 'https://jobs.ashbyhq.com/northwind/one';
      const board = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
      const other = 'https://jobs.ashbyhq.com/cedar/two';
      const root = 'https://northwind.test/';
      const pages = { [root]: `<title>${EMPLOYER}</title><a href="${first}">Software Engineer</a>`,
        [first]: posting(first, { hiringOrganization: { name: EMPLOYER, sameAs: root } }),
        [board]: { body: JSON.stringify({ jobs: [] }), contentType: 'application/json' } };
      for (const failed of [board, other]) for (const code of ['fetch-failed', 'fetch-timeout']) {
        const store = memoryStore(); const seen = [];
        const result = await resolveOfficialPosting(row(), { store, candidateUrls: [other, first], fetch: async url => {
          seen.push(url); if (url === failed) throw error(code); return network(pages)(url);
        } });
        // The actual fetched employer root links this exact ATS posting.
        assert.equal(result.officialPosting.level, 'L2', JSON.stringify(result.officialPosting));
        assert.ok(seen.includes(board), 'same-tenant board adapter is read even after the text winner');
        assert.equal(result.officialPosting.trail.includes('crawl-partial'), failed === board);
        assert.equal(store.saved.length, failed === board ? 0 : 1, `${failed} / ${code}`);
      }
    },
  },
  {
    name: 'Amendment 5 a same-pay winner with an unread queued sibling is not durable when the row budget ends',
    async run() {
      const first = 'https://northwind.test/jobs/one'; const sibling = 'https://northwind.test/jobs/two';
      const salary = { '@type': 'MonetaryAmount', currency: 'CAD', value: { '@type': 'QuantitativeValue', minValue: 120000, maxValue: 140000, unitText: 'YEAR' } };
      const pages = { 'https://northwind.test/': `<title>${EMPLOYER}</title>`, [first]: posting(first, { description: `${DESCRIPTION} Further duties concern fleet forecasting.`, baseSalary: salary }) };
      let clock = 0; const store = memoryStore(); const requests = [];
      const budget = createOfficialPostingRowBudget({ timeoutMs: 10, now: () => clock });
      try {
        const result = await resolveOfficialPosting(row({ salary: 'CAD 120000-140000 YEAR', salaryProvenance: 'posted' }), {
          store, rowBudget: budget, candidateUrls: [first, sibling], fetch: async url => {
            requests.push(url); const value = await network(pages)(url); if (url === first) clock += 20; return value;
          } });
        assert.equal(result.officialPosting.level, 'L1'); assert.ok(result.officialPosting.trail.includes('salary-anchor'));
        assert.ok(result.officialPosting.trail.includes('crawl-partial')); assert.ok(!requests.includes(sibling));
        assert.equal(budget.signal.reason.code, 'fetch-timeout'); assert.equal(store.saved.length, 0);
      } finally { budget.dispose(); }
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
    name: 'R3 legacy standalone negative checks remain non-durable while the service can own verified-result writes',
    async run() {
      const clean = memoryStore();
      const researched = await resolveOfficialPosting(row(), { store: clean, research: async () => [] });
      assert.equal(clean.saved.length, 0); assert.ok(researched.officialPosting.trail.includes('bridge-research'));
      assert.equal(officialPostingLookupStatus(researched.officialPosting).retryable, true);
      assert.equal(researched.officialPosting.trail.includes(OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL), false);
      const closed = memoryStore();
      await resolveOfficialPosting(row({ url: 'https://northwind.test/jobs/closed' }), {
        store: closed, fetch: async () => { throw error('closed'); },
      });
      assert.equal(closed.saved.length, 0, 'a closed-page legacy lookup supplies no new semantic negative proof');
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
        await store.save(job, { officialPosting: miss(['bridge-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL]) });
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
      // The root names no careers page, so its conventional /careers path is the second read of the first pass.
      let clock = 0; const requests = []; const budget = createOfficialPostingRowBudget({ timeoutMs: 15, now: () => clock });
      try {
        const fetch = async url => { requests.push(url); clock += 6; return html(`<title>${EMPLOYER}</title>`, url); };
        await resolveOfficialPosting(row(), { rowBudget: budget, fetch, candidateUrls: ['https://northwind.test/'] });
        assert.equal(budget.signal.aborted, false);
        clock += 1_000_000;
        const second = await resolveOfficialPosting(row(), { rowBudget: budget, fetch, candidateUrls: ['https://northwind.test/jobs/one'] });
        assert.deepEqual(requests, ['https://northwind.test/', 'https://northwind.test/careers', 'https://northwind.test/jobs/one'],
          'the handoff gap does not consume the remaining host time');
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
  {
    name: 'Amendment 5 resolver accepts recruiter paraphrase only after two serial verbatim-grounded comparative runs',
    async run() {
      const fixture = comparisonFixture(); const calls = []; let active = 0;
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true,
        match: async (job, options, context) => {
          assert.equal(active++, 0, 'independent runs are serial');
          calls.push(context.run); await Promise.resolve(); active--;
          const request = buildOfficialPostingMatchRequest({ job, options, run: context.run, peerCandidates: context.peerCandidates });
          const rebuilt = buildOfficialPostingMatchRequest({ job: structuredClone(job), options: structuredClone(options), run: context.run, peerCandidates: context.peerCandidates });
          assert.equal(request.prompt, rebuilt.prompt, 'resume rebuild is byte-identical');
          return comparisonAnswer(options, fixture);
        } });
      assert.deepEqual(calls, ['A', 'B']); assert.equal(result.officialPosting.level, 'L1');
      assert.ok(result.officialPosting.trail.includes('comparative-match'));
      assert.ok(result.officialPosting.trail.includes('comparative-a-valid'));
      assert.ok(result.officialPosting.trail.includes('comparative-b-valid'));
      assert.ok(result.officialPosting.trail.includes('comparative-choice-p1'));
      assert.equal(result.officialPosting.sourceUrl, fixture.candidateUrls[0]);
      assert.equal(result.comparison.accepted, true); assert.equal(result.comparison.agreement, true);
      const words = value => new Set(value.toLowerCase().match(/[a-z]+/gu));
      for (let index = 0; index < 3; index++) {
        const official = words(COMPARATIVE_OFFICIAL[index]);
        assert.ok([...words(COMPARATIVE_SCRAPED[index])].filter(word => official.has(word)).length < 4, 'the removed shared-vocabulary floor rejected every paraphrase pair');
      }
    },
  },
  {
    name: 'Amendment 5 resolver compares live same-title same-city teams and excludes another-city twin from requests',
    async run() {
      const fixture = comparisonFixture([{ id: 'one' }, { id: 'two', quotes: COMPARATIVE_SIBLING }, { id: 'city-twin', city: 'Riverton' }]);
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true,
        match: async (job, options, context) => {
          assert.equal(options.length, 2); assert.ok(options.every(option => !option.location.includes('Riverton')));
          const request = buildOfficialPostingMatchRequest({ job, options, run: context.run });
          assert.equal(request.prompt.includes('Riverton'), false);
          return comparisonAnswer(options, fixture, options.find(option => option.candidate.sourceUrl.endsWith('/one')).id);
        } });
      assert.equal(result.officialPosting.sourceUrl, fixture.candidateUrls[0]); assert.equal(result.comparison.optionCount, 2);
      let calls = 0; const store = memoryStore();
      const invalid = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true, store,
        match: async (_job, options) => { calls++; return { ...comparisonAnswer(options, fixture), distinguishing: [] }; } });
      assert.equal(invalid.officialPosting.outcome, 'not-found'); assert.ok(invalid.officialPosting.trail.includes('comparative-invalid'));
      assert.equal(calls, 4, 'each independent invalid run receives exactly one correction');
      assert.equal(invalid.comparison.invalidRuns, 2); assert.equal(store.saved.length, 0);
    },
  },
  {
    name: 'Amendment 5 resolver chooses a closed paraphrased true posting rather than its live sibling',
    async run() {
      const fixture = comparisonFixture([{ id: 'one', closed: true }, { id: 'two', quotes: COMPARATIVE_SIBLING }]);
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true,
        match: async (_job, options) => {
          const closed = options.find(option => option.status === 'closed'); assert.ok(closed);
          return comparisonAnswer(options, fixture, closed.id);
        } });
      assert.equal(result.officialPosting.outcome, 'closed'); assert.equal(result.officialPosting.sourceUrl, undefined);
      assert.equal(result.comparison.agreement, true); assert.equal(result.comparison.accepted, false);
      assert.ok(result.officialPosting.trail.includes('comparative-choice-p1'));
    },
  },
  {
    name: 'Amendment 5 resolver records comparative disagreement and only the chosen alternatives without evidence text',
    async run() {
      const fixture = comparisonFixture([{ id: 'one' }, { id: 'two', quotes: COMPARATIVE_SIBLING }]);
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true,
        match: async (_job, options, { run }) => comparisonAnswer(options, fixture, options[run === 'A' ? 0 : 1].id) });
      assert.equal(result.officialPosting.outcome, 'ambiguous'); assert.ok(result.officialPosting.trail.includes('comparative-disagree'));
      assert.deepEqual(result.officialPosting.alternatives.map(item => item.url), fixture.candidateUrls);
      assert.equal(result.comparison.disagreement, true); assert.equal(result.comparison.accepted, false);
      assert.equal(/Quote|description|reason|Requirements/u.test(JSON.stringify(result.comparison)), false);
    },
  },
  {
    name: 'Amendment 5 resolver retries a fabricated or wrong-option quote exactly once and never stores an invalid comparison',
    async run() {
      for (const kind of ['fabricated', 'wrong-option']) {
        const fixture = comparisonFixture([{ id: 'one' }, { id: 'two', quotes: COMPARATIVE_SIBLING }]);
        const calls = []; const store = memoryStore();
        const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true, store,
          match: async (_job, options, context) => {
            calls.push(context);
            if (context.correctionAttempt) {
              assert.ok(context.correctionRuleIds.includes('LOOKUP_OFFICIAL_MATCH_VERBATIM'));
              assert.ok(context.correctionDetails.every(line => line.length <= 260));
            }
            const answer = comparisonAnswer(options, fixture);
            answer.evidence[0].officialQuote = kind === 'fabricated' ? 'A completely fabricated passage about unrelated nocturnal satellite navigation duties.' : COMPARATIVE_SIBLING[0];
            return answer;
          } });
        assert.deepEqual(calls.map(call => [call.run, call.correctionAttempt || 0]), [['A', 0], ['A', 1], ['B', 0], ['B', 1]]);
        assert.ok(result.officialPosting.trail.includes('comparative-invalid')); assert.equal(store.saved.length, 0);
      }
    },
  },
  {
    name: 'Amendment 6 legacy resolver compares merged requisitions while unexamined distinct requisitions remain non-durable',
    async run() {
      for (const same of [false, true]) {
        const fixture = comparisonFixture([{ id: 'one', extra: same ? { identifier: 'request-shared' } : {} },
          { id: 'two', extra: same ? { identifier: 'request-shared' } : {} }]);
        let calls = 0; const store = memoryStore();
        const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, store, researchRan: true,
          match: async (_job, options) => { calls++; assert.equal(options.length, 1); return comparisonAnswer(options, fixture); } });
        assert.equal(calls, same ? 2 : 0);
        assert.equal(result.officialPosting.outcome, same ? 'found' : 'ambiguous');
        assert.equal(store.saved.length, same ? 1 : 0);
        if (!same) {
          assert.ok(result.officialPosting.trail.includes('ambiguous'));
          assert.ok(!result.officialPosting.trail.includes('comparative-invalid'));
          assert.equal(result.officialPosting.alternatives.length, 2);
        }
      }
    },
  },
  {
    name: 'Amendment 6 wrong-sibling review scenario rejects a shared-evidence wrong choice and accepts the matching team',
    async run() {
      const shared = DESCRIPTION.split(/(?<=\.)\s+/u);
      const teamA = 'Team: Payments Platform. You will own the settlement services for the payments platform group and its on call rotation.';
      const teamB = 'Team: Risk Engineering. You will own the fraud scoring services for the risk engineering group and its on call rotation.';
      const recruiter = 'Recruiters note that the candidate will join a friendly group.';
      const scraped = `${teamA} ${recruiter} ${shared[0]} Occasional travel may be needed. ${shared[4]} Mentoring newer colleagues is encouraged.`;
      const fixture = comparisonFixture([{ id: 'one', extra: { description: `${teamA} ${shared.join(' ')}` } },
        { id: 'two', extra: { description: `${teamB} ${shared.join(' ')}` } }]);
      for (const correct of [false, true]) {
        let calls = 0;
        const result = await resolveOfficialPosting(comparisonRow({ snippet: scraped }), { ...fixture, researchRan: true,
          match: async (_job, options, context) => {
            calls++;
            if (context.correctionAttempt) assert.ok(context.correctionRuleIds.includes('LOOKUP_OFFICIAL_MATCH_DISTINCTIVE'));
            const chosen = options.find(option => option.candidate.sourceUrl.endsWith(correct ? '/one' : '/two'));
            const other = options.find(option => option !== chosen);
            return { choice: chosen.id, conflicts: [], evidence: [
              { scrapedQuote: shared[0], officialQuote: shared[0] }, { scrapedQuote: shared[4], officialQuote: shared[4] },
              { scrapedQuote: correct ? teamA : recruiter, officialQuote: correct ? teamA : teamB } ],
            distinguishing: [{ optionId: other.id, officialQuote: correct ? 'Team: Payments Platform' : 'Team: Risk Engineering', reason: 'The operating team differs.' }] };
          } });
        assert.equal(calls, correct ? 2 : 4);
        assert.equal(result.officialPosting.outcome, correct ? 'found' : 'not-found');
        assert.equal(result.comparison.accepted, correct);
        if (correct) assert.equal(result.officialPosting.sourceUrl, fixture.candidateUrls[0]);
        else assert.ok(result.officialPosting.trail.includes('comparative-invalid'));
      }
    },
  },
  {
    name: 'Amendment 8 live same-requisition copy stays found when an earlier URL is closed',
    async run() {
      const fixture = comparisonFixture([{ id: 'closed-embed', closed: true, extra: { identifier: 'request-shared' } },
        { id: 'live', extra: { identifier: 'request-shared' } }]);
      const calls = [];
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true,
        match: async (_job, options) => { calls.push(options); return comparisonAnswer(options, fixture); } });
      assert.equal(result.officialPosting.outcome, 'found');
      assert.equal(result.officialPosting.sourceUrl, fixture.candidateUrls[1]);
      assert.equal(calls.length, 2); assert.ok(calls.every(options => options.length === 1 && options[0].status === 'live'));
    },
  },
  {
    name: 'Amendment 9 serial-comma copies preserve the true live comparative match for either scraped presentation',
    async run() {
      const lines = DESCRIPTION.split(/(?<=\.)\s+/u);
      const commaCopy = DESCRIPTION.replace('building reliable services and maintaining', 'building reliable services, and maintaining')
        .replace('improving data quality across scheduled pipelines and documenting', 'improving data quality across scheduled pipelines, and documenting');
      const noise = ['Recruiters add that the group enjoys flexible schedules and frequent offsite gatherings throughout the year.',
        'Candidates should enjoy mentoring newer colleagues and sharing knowledge widely across the organization.',
        'Occasional travel to regional offices may be needed during the first quarter of employment.',
        'Our culture values curiosity and steady collaboration between engineering and partner teams.',
        'You will also join a friendly rotation that celebrates milestones with team lunches.',
        'Relocation assistance may be available for exceptional candidates who join the group.'];
      for (const source of [DESCRIPTION, commaCopy]) {
        const parts = source.split(/(?<=\.)\s+/u);
        const fixture = comparisonFixture([{ id: 'copy-a', extra: { identifier: 'request-shared', description: DESCRIPTION } },
          { id: 'copy-b', extra: { identifier: 'request-shared', description: commaCopy } }]);
        const input = comparisonRow({ snippet: parts.flatMap((part, index) => [noise[index], part]).concat(noise[5]).join(' ') });
        let calls = 0;
        const result = await resolveOfficialPosting(input, { ...fixture, researchRan: true,
          match: async (_job, options) => { calls++; return { choice: options[0].id, conflicts: [],
            evidence: [lines[1], lines[3], lines[4]].map(quote => ({ scrapedQuote: quote, officialQuote: quote })), distinguishing: [] }; } });
        assert.equal(result.officialPosting.outcome, 'found', source);
        assert.equal(result.officialPosting.sourceUrl, fixture.candidateUrls[0]);
        assert.equal(calls, 2);
      }
    },
  },
  {
    name: 'Amendment 9 non-nested same-requisition copies with different role passages remain comparative-invalid',
    async run() {
      const lines = DESCRIPTION.split(/(?<=\.)\s+/u);
      const x = 'The team also covers weekend dispatch coverage for regional partners during quarterly peak planning cycles each year.';
      const y = 'Engineers rotate through a shared on call schedule and publish a short written summary after every incident review.';
      for (const closed of [null, 'a', 'b']) {
        const fixture = comparisonFixture([{ id: 'a', closed: closed === 'a', extra: { identifier: 'request-shared', description: `${DESCRIPTION} ${y}` } },
          { id: 'b', closed: closed === 'b', extra: { identifier: 'request-shared', description: `${DESCRIPTION} ${x}` } }]);
        const input = comparisonRow({ snippet: [lines[0], x, lines[2], y, lines[4]].join(' ') });
        let calls = 0;
        const result = await resolveOfficialPosting(input, { ...fixture, researchRan: true,
          match: async (_job, options) => { calls++; return { choice: options[0].id, conflicts: [],
            evidence: [lines[0], lines[2], lines[4]].map(quote => ({ scrapedQuote: quote, officialQuote: quote })), distinguishing: [] }; } });
        assert.equal(result.officialPosting.outcome, 'not-found', closed);
        assert.ok(result.officialPosting.trail.includes('comparative-invalid'));
        assert.equal(calls, 4);
      }
    },
  },
  {
    name: 'Amendment 8 pay-vetoed true text still contradicts a wrong visible sibling without entering AI options',
    async run() {
      await hiddenContradictionScenario('pay');
    },
  },
  {
    name: 'Amendment 8 cap-dropped true text still contradicts a wrong visible sibling without entering AI options',
    async run() {
      await hiddenContradictionScenario('cap');
    },
  },
  {
    name: 'Amendment 8 collapsed duplicate text still contradicts its chosen representation without entering AI options',
    async run() {
      await hiddenContradictionScenario('collapse');
    },
  },
  {
    name: 'Amendment 6 insufficient scraped input skips comparative handoffs and cannot become a settled miss',
    async run() {
      const fixture = comparisonFixture();
      for (const snippet of ['', 'A short description names the engineering role without enough separate passages to support reliable comparison across different source sections.', Array(30).fill('word').join(' ')]) {
        let calls = 0; const store = memoryStore();
        const result = await resolveOfficialPosting(comparisonRow({ snippet }), { ...fixture, researchRan: true, store,
          match: async () => { calls++; return comparisonAnswer([], fixture, 'none'); } });
        assert.equal(calls, 0); assert.equal(result.comparison, undefined);
        assert.ok(result.officialPosting.trail.includes('insufficient-text'));
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        assert.equal(store.saved.length, 0);
      }
    },
  },
  {
    name: 'Amendment 6 none-none on more than eight eligible options records truncation and remains retryable',
    async run() {
      const fixture = comparisonFixture(Array.from({ length: 10 }, (_, index) => ({ id: `option-${index}`,
        quotes: COMPARATIVE_OFFICIAL.map((line, part) => `${line} Scope ${index} part ${part} covers distinct operating needs.`) })));
      let calls = 0; const store = memoryStore();
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true, store,
        match: async (_job, options) => { calls++; assert.equal(options.length, 8); return comparisonAnswer([], fixture, 'none'); } });
      assert.equal(calls, 2); assert.equal(result.comparison.preCapCount, 10); assert.equal(result.comparison.truncated, true);
      assert.ok(result.officialPosting.trail.includes('comparative-truncated'));
      assert.equal(result.officialPosting.trail.includes('comparative-none'), false);
      assert.equal(result.officialPosting.outcome, 'not-found'); assert.equal(store.saved.length, 0);
      assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
    },
  },
  {
    name: 'Amendment 5 resolver corrects one invalid run without sharing its answer with the other independent run',
    async run() {
      const fixture = comparisonFixture(); const calls = [];
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true,
        match: async (_job, options, context) => {
          calls.push(context);
          assert.equal(Object.hasOwn(context, 'answer'), false);
          if (context.run === 'A' && !context.correctionAttempt) return { choice: 'invented', evidence: [], distinguishing: [], conflicts: [] };
          return comparisonAnswer(options, fixture);
        } });
      assert.deepEqual(calls.map(call => [call.run, call.correctionAttempt || 0]), [['A', 0], ['A', 1], ['B', 0]]);
      assert.equal(result.officialPosting.level, 'L1'); assert.equal(result.comparison.invalidRuns, 0);
    },
  },
  {
    name: 'Amendment 5 legacy none-none comparisons remain non-durable without upgraded semantic discovery',
    async run() {
      const fixture = comparisonFixture();
      const settled = memoryStore();
      const none = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true, store: settled,
        match: async () => comparisonAnswer([], fixture, 'none') });
      assert.equal(none.officialPosting.outcome, 'not-found'); assert.ok(none.officialPosting.trail.includes('comparative-none'));
      assert.equal(none.comparison.none, true); assert.equal(settled.saved.length, 0);
      assert.equal(none.officialPosting.trail.includes(OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL), false);
      assert.equal(officialPostingLookupStatus(none.officialPosting).retryable, true);
      for (const code of ['bridge-timeout', 'bridge-aborted', 'comparative-unavailable']) {
        const store = memoryStore();
        const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true, store,
          match: async (_job, options, { run }) => { if (run === 'B') throw error(code); return comparisonAnswer(options, fixture); } });
        assert.equal(result.officialPosting.outcome, 'not-found'); assert.equal(store.saved.length, 0, code);
        assert.equal(result.comparison.validA, true); assert.equal(result.comparison.validB, false);
        assert.ok(result.officialPosting.trail.includes(code));
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
      }
      const unavailable = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true });
      assert.ok(unavailable.officialPosting.trail.includes('comparative-unavailable'));
      assert.equal(shouldPersistOfficialPostingResult(unavailable, { researchRan: true }), false);
    },
  },
  {
    name: 'Amendment 6 resolver excludes posted-pay vetoes and retains definitive closed-winner gates without handoffs',
    async run() {
      const salary = { '@type': 'MonetaryAmount', currency: 'CAD', value: { '@type': 'QuantitativeValue', minValue: 200000, maxValue: 220000, unitText: 'YEAR' } };
      const fixture = comparisonFixture([{ id: 'one', extra: { baseSalary: salary } }]);
      for (const closed of [false, true]) {
        let calls = 0; const store = memoryStore();
        const payFixture = closed ? comparisonFixture([{ id: 'one', closed: true, extra: { baseSalary: salary } }]) : fixture;
        const vetoed = await resolveOfficialPosting(comparisonRow({ salary: 'CAD 120000-140000 YEAR', salaryProvenance: 'posted' }), { ...payFixture, researchRan: true, store,
          match: async () => { calls++; throw new Error('A posted-pay veto must never enter comparative matching'); } });
        assert.equal(vetoed.officialPosting.outcome, 'not-found'); assert.ok(vetoed.officialPosting.trail.includes('salary-mismatch'));
        assert.equal(vetoed.comparison, undefined); assert.equal(calls, 0);
        assert.equal(vetoed.officialPosting.trail.includes('comparative-invalid'), false);
        assert.equal(shouldPersistOfficialPostingResult(vetoed, { researchRan: true }), false); assert.equal(store.saved.length, 0);
      }
      const closed = comparisonFixture([{ id: 'one', closed: true }, { id: 'two', quotes: [...COMPARATIVE_OFFICIAL, 'Additional requirements cover internal accounting tools and monthly billing workflows.'] }]);
      let calls = 0;
      const deterministic = await resolveOfficialPosting(comparisonRow({ snippet: `Requirements: ${COMPARATIVE_OFFICIAL.join(' ')}` }), { ...closed, researchRan: true,
        match: async () => { calls++; throw new Error('A settled closed winner needs no comparison'); } });
      assert.equal(deterministic.officialPosting.outcome, 'closed'); assert.equal(calls, 0);
    },
  },
  {
    name: 'Amendment 6 late agreed-choice vetoes preserve reasons while only closed facts remain durable without upgraded discovery',
    async run() {
      for (const veto of ['salary-mismatch', 'closed-winner', 'outranked']) {
        const fixture = comparisonFixture(veto === 'salary-mismatch' ? [{ id: 'one' }]
          : [{ id: 'one' }, { id: 'two', quotes: COMPARATIVE_SIBLING }]);
        const store = memoryStore(); let calls = 0;
        const result = await resolveOfficialPosting(comparisonRow(veto === 'salary-mismatch' ? { salary: 'CAD 120000-140000 YEAR', salaryProvenance: 'posted' } : {}), {
          ...fixture, store, researchRan: true, match: async (_job, options, { run }) => {
            calls++;
            const chosen = options.find(option => option.candidate.sourceUrl.endsWith('/one'));
            if (run === 'B') {
              if (veto === 'salary-mismatch') chosen.candidate.salary = { text: 'CAD 200000-220000 YEAR', provenance: 'posted' };
              else {
                const sibling = options.find(option => option !== chosen).candidate;
                sibling.description = comparisonRow().snippet;
                if (veto === 'closed-winner') sibling.validThrough = '2000-01-01T00:00:00Z';
              }
            }
            return comparisonAnswer(options, fixture, chosen.id);
          } });
        assert.equal(calls, 2); assert.equal(result.comparison.agreement, true); assert.equal(result.comparison.accepted, false);
        assert.equal(result.officialPosting.trail.includes('comparative-invalid'), false, veto);
        assert.ok(result.officialPosting.trail.includes(veto === 'closed-winner' ? 'closed' : veto === 'outranked' ? 'no-anchor' : veto));
        assert.equal(result.officialPosting.outcome, veto === 'closed-winner' ? 'closed' : 'not-found');
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), veto === 'closed-winner', veto);
        assert.equal(store.saved.length, veto === 'closed-winner' ? 1 : 0);
      }
    },
  },
  {
    name: 'Amendment 5 resolver rejects boilerplate-only comparative evidence from fetched other-title peers',
    async run() {
      const fixture = comparisonFixture([{ id: 'one' }, ...Array.from({ length: 5 }, (_, index) => ({ id: `peer-${index}`, title: `Designer ${index}` }))]);
      const store = memoryStore(); const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, researchRan: true, store,
        match: async (_job, options) => { assert.equal(options.length, 1); return comparisonAnswer(options, fixture); } });
      assert.ok(result.officialPosting.trail.includes('comparative-invalid')); assert.equal(result.comparison.invalidRuns, 2);
      assert.equal(store.saved.length, 0);
    },
  },
  {
    name: 'Amendment 5 resolver waits for research and never compares empty identity sets or settled deterministic matches',
    async run() {
      const fixture = comparisonFixture(); let calls = 0;
      const match = async () => { calls++; throw new Error('This row must settle before comparative matching'); };
      const free = await resolveOfficialPosting(comparisonRow(), { ...fixture, match });
      assert.equal(free.comparison, undefined); assert.equal(calls, 0);
      const foreign = await resolveOfficialPosting(comparisonRow({ company: 'Cedar Works' }), { ...fixture, match, researchRan: true });
      assert.equal(foreign.comparison, undefined); assert.equal(calls, 0);
      const deterministic = await resolveOfficialPosting(comparisonRow({ snippet: `Requirements: ${COMPARATIVE_OFFICIAL.join(' ')}` }), { ...fixture, match, researchRan: true });
      assert.equal(deterministic.officialPosting.level, 'L1'); assert.ok(deterministic.officialPosting.trail.includes('description-anchor'));
      assert.equal(deterministic.comparison, undefined); assert.equal(calls, 0);
    },
  },
  {
    name: 'Amendment 5 resolver rechecks liveness after both independent judgments before accepting a posting',
    async run() {
      let clock = Date.parse('2026-01-01T00:00:00Z');
      const fixture = comparisonFixture([{ id: 'one', extra: { validThrough: new Date(clock + 1000).toISOString() } }]);
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, now: () => clock, researchRan: true,
        match: async (_job, options, { run }) => {
          assert.equal(options[0].status, 'live');
          if (run === 'B') clock += 2000;
          return comparisonAnswer(options, fixture);
        } });
      assert.equal(result.comparison.validA, true); assert.equal(result.comparison.validB, true);
      assert.equal(result.comparison.accepted, false); assert.equal(result.officialPosting.outcome, 'closed');
      assert.equal(result.officialPosting.sourceUrl, undefined); assert.ok(result.officialPosting.trail.includes('closed'));
      assert.equal(result.officialPosting.trail.includes('comparative-match'), false);
    },
  },
  {
    name: 'Amendment 5 resolver refuses a late valid injected answer after the row was aborted',
    async run() {
      const controller = new AbortController(); const fixture = comparisonFixture(); const store = memoryStore();
      const result = await resolveOfficialPosting(comparisonRow(), { ...fixture, store, signal: controller.signal, researchRan: true,
        match: async (_job, options, { run }) => {
          if (run === 'B') controller.abort(error('bridge-aborted'));
          return comparisonAnswer(options, fixture);
        } });
      assert.equal(result.comparison.validA, true); assert.equal(result.comparison.validB, false);
      assert.equal(result.comparison.accepted, false); assert.equal(result.officialPosting.outcome, 'not-found');
      assert.equal(store.saved.length, 0); assert.ok(result.officialPosting.trail.includes('bridge-aborted'));
      assert.equal(result.officialPosting.trail.includes('comparative-match'), false);
    },
  },
];
