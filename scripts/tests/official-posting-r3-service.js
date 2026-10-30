import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { COMPARATIVE_SCRAPED, COMPARATIVE_OFFICIAL, COMPARATIVE_SIBLING, comparisonRow, comparisonFixture } from './official-posting-r3-resolver.js';
import { officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';
import { boundedOfficialPostingTrail, normalizeOfficialPosting, OFFICIAL_POSTING_TRAIL, officialPostingComparativeTrail } from '../../electron/ipc/officialPostingFields.js';
import { officialPostingChunks, resolveOfficialPosting, unresolvedOfficialPosting, shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import { mergeOfficialPostingTelemetry, partitionOfficialPostingRows as partitionRows, resolveOfficialPostings as resolveRows } from '../../electron/ipc/officialPostingService.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
// These legacy fixtures pin the earlier deterministic/comparative contract.
const partitionOfficialPostingRows = (jobs, options) => partitionRows(jobs, { semanticMatching: false, ...options });
const resolveOfficialPostings = (jobs, options) => resolveRows(jobs, { semanticMatching: false, ...options });

const description = 'Requirements include building reliable dispatch services, reviewing route reports, and documenting operational changes with the engineering team.';
const job = (id, extra = {}) => ({ title: `Dispatch Engineer ${id}`, company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
  snippet: description, url: `https://mirror.example/jobs/${id}`, sourceJobKey: `source-${id}`, ...extra });
const posting = (extra = {}) => ({ level: 'L4', outcome: 'link-only', employer: 'Northwind Labs', title: 'Dispatch Engineer',
  sourceUrl: 'https://northwind.test/jobs/dispatch', officialApplyUrl: 'https://northwind.test/jobs/dispatch', trail: [], ...extra });
const record = (row, value, savedAt = Date.now()) => ({ version: 1, aliases: officialPostingAliases(row), savedAt, officialPosting: normalizeOfficialPosting(value) });
const response = prompt => prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ').map(id =>
  `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function memoryStore(initial = []) {
  const records = new Map(initial); const saves = [];
  return { saves, records, find: async row => records.get(row.sourceJobKey) || null,
    save: async (row, payload) => { saves.push({ row, payload }); const value = record(row, payload.officialPosting); records.set(row.sourceJobKey, value); return value; } };
}
const noNetwork = () => { throw new Error('This service fixture must not fetch.'); };

function comparisonVisible(prompt) {
  return JSON.parse(prompt.split('BEGIN UNTRUSTED POSTING COMPARISON JSON\n')[1].split('\nEND UNTRUSTED POSTING COMPARISON JSON')[0]);
}
function serviceComparisonAnswer(visible, selected = null) {
  if (selected === 'none') return { choice: 'none', evidence: [], distinguishing: [], conflicts: [] };
  const chosen = selected ? visible.options.find(option => option.id === selected)
    : visible.options.find(option => option.description.includes(COMPARATIVE_OFFICIAL[0]));
  const quotes = chosen.description.includes(COMPARATIVE_OFFICIAL[0]) ? COMPARATIVE_OFFICIAL : COMPARATIVE_SIBLING;
  return { choice: chosen.id, evidence: quotes.map((quote, index) => ({ scrapedQuote: COMPARATIVE_SCRAPED[index], officialQuote: quote })),
    distinguishing: visible.options.filter(option => option.id !== chosen.id && option.status === 'live').map(option => ({
      optionId: option.id, officialQuote: quotes[0], reason: 'The chosen role belongs to a different operating team and scope.' })), conflicts: [] };
}
function comparativeServiceFixture(specs) {
  const fixture = comparisonFixture(specs);
  return { ...fixture,
    fetchSession: { fetch: fixture.fetch, telemetry: () => ({ fetches: 0, uniqueUrls: 0, cacheHits: 0, maxPerHostRate: 0, breakerTrips: 0 }) },
    research: async (prompt, options) => {
      assert.equal(options.task, 'job-official-posting-research');
      const ids = prompt.match(/Requested ids: ([a-f0-9, ]+)\./u)[1].split(', ');
      return ids.map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\n${fixture.candidateUrls.map(postingUrl => `CANDIDATE: ${JSON.stringify({ careersPageUrl: '', postingUrl, employer: 'Northwind Labs', employerDomain: 'https://northwind.test/', ats: '' })}`).join('\n')}\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
    } };
}
export { comparisonVisible, serviceComparisonAnswer, comparativeServiceFixture };

export default [
  {
    name: 'deferred expiry partition retries historical closed-trail misses with no candidate confirmation receipt',
    async run() {
      const target = job('synthetic-legacy-expiry', { officialPosting: { level: 'L5', outcome: 'not-found',
        employer: 'Northwind Labs', trail: ['bridge-research', 'closed'] } });
      const old = record(target, { level: 'L5', outcome: 'not-found', employer: target.company,
        trail: ['bridge-research', 'closed'] });
      const partition = await partitionOfficialPostingRows([target], { store: memoryStore([[target.sourceJobKey, old]]) });
      assert.deepEqual(partition.unresolvedIndices, [0]);
      assert.equal(partition.settledTelemetry.total, 0);
    },
  },
  {
    name: 'deferred expiry service keeps candidate URLs in a run receipt and does not persist an unconfirmed miss',
    async run() {
      const target = job('synthetic-expiry');
      const url = 'https://northwind.test/jobs/synthetic-expiry';
      const store = memoryStore();
      const resolved = await resolveOfficialPostings([target], { store, fetch: noNetwork, bridgeAvailable: false,
        resolve: async () => ({ officialPosting: { level: 'L5', outcome: 'not-found', employer: 'Northwind Labs',
          trail: ['closed'] }, expiryCandidates: [url] }) });
      assert.deepEqual(resolved.expiryCandidates, [[url]]);
      assert.equal(resolved.jobs[0].expiryCandidates, undefined, 'URLs stay off rows');
      assert.equal(store.saves.length, 0, 'the service cannot cache a miss before candidate confirmation');
    },
  },
  {
    name: 'comparative trail compaction never turns a saturated partial crawl into a durable match',
    run() {
      const decorations = OFFICIAL_POSTING_TRAIL.filter(code => !code.startsWith('comparative-')
        && !['identifier-anchor', 'crawl-partial', 'fetch-timeout', 'crawl-budget'].includes(code));
      const flags = officialPostingComparativeTrail({ validA: true, validB: true, choiceA: 'P3', choiceB: 'P3' });
      const trail = boundedOfficialPostingTrail([...decorations, 'comparative-match', ...flags, 'crawl-partial']);
      assert.equal(trail.length, 32); assert.ok(trail.includes('crawl-partial'));
      for (const flag of flags) assert.ok(trail.includes(flag));
      assert.equal(shouldPersistOfficialPostingResult(posting({ level: 'L1', outcome: 'found', trail })), false);
      assert.deepEqual(boundedOfficialPostingTrail(['careers-page', 'comparative-match']), ['careers-page', 'comparative-match']);
    },
  },
  {
    name: 'comparative telemetry merges counts and closed option bins without retaining evidence or arbitrary labels',
    run() {
      const block = { comparisons: 2, comparisonOptions: { 1: 1, 8: 1, PRIVATE_OPTION: 9 },
        comparativeAgreements: 1, comparativeDisagreements: 1, comparativeInvalidRuns: 2,
        comparativeNone: 1, comparativeUnavailable: 1, comparativeMatches: 1,
        rejections: { 'comparative-invalid': 1, 'comparative-match': 1, 'semantic-uncertain': 1, 'semantic-overflow': 1, PRIVATE_REASON: 1 },
        evidence: 'PRIVATE_EVIDENCE', conversation: 'PRIVATE_CONVERSATION' };
      const merged = mergeOfficialPostingTelemetry(block, block);
      assert.equal(merged.comparisons, 4); assert.equal(merged.comparativeAgreements, 2);
      assert.equal(merged.comparativeDisagreements, 2); assert.equal(merged.comparativeInvalidRuns, 4);
      assert.equal(merged.comparativeNone, 2); assert.equal(merged.comparativeUnavailable, 2);
      assert.equal(merged.comparativeMatches, 2);
      assert.deepEqual(merged.comparisonOptions, { 1: 2, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 2 });
      assert.equal(merged.rejections['comparative-invalid'], 2);
      assert.equal(merged.rejections['semantic-uncertain'], 2);
      assert.equal(merged.rejections['semantic-overflow'], 2);
      assert.equal(merged.rejections['comparative-match'], undefined);
      assert.equal(JSON.stringify(merged).includes('PRIVATE_'), false);
    },
  },
  {
    name: 'R3 service partitions only normalized identity-bound settled rows and overlays host metadata without changing scraped fields',
    async run() {
      const now = Date.parse('2026-02-01T12:00:00Z');
      const rows = Array.from({ length: 8 }, (_, index) => job(index, { officialPosting: posting() }));
      rows[0].officialPosting = posting({ employer: 'Forged Example', sourceUrl: 'https://forged.test/job' });
      delete rows[1].officialPosting;
      rows[7].officialPosting = { ...posting(), extra: 'invalid' };
      const valid = record(rows[0], posting({ level: 'L1', outcome: 'found' }), now);
      const wrong = record(job(200, { title: 'Finance Analyst' }), posting(), now);
      const clean = record(rows[3], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] }), now - 1_000);
      const transient = record(rows[4], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-aborted'] }), now - 1_000);
      const unproven = record(rows[5], posting({ level: 'L5', outcome: 'not-found' }), now - 1_000);
      const expired = record(rows[6], posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-research'] }), now - 24 * 60 * 60 * 1_000);
      const store = memoryStore([[rows[0].sourceJobKey, valid], [rows[1].sourceJobKey, record(rows[1], posting(), now)],
        [rows[2].sourceJobKey, wrong], [rows[3].sourceJobKey, clean], [rows[4].sourceJobKey, transient], [rows[5].sourceJobKey, unproven], [rows[6].sourceJobKey, expired]]);
      const before = JSON.stringify(rows);
      const result = await partitionOfficialPostingRows(rows, { store, now });
      assert.equal(JSON.stringify(rows), before);
      assert.deepEqual(result.unresolvedIndices, [1, 2, 4, 5, 6, 7]);
      assert.deepEqual(result.jobs[0].officialPosting, valid.officialPosting, 'inline proof is replaced by host-owned proof');
      assert.equal(result.jobs[0].company, rows[0].company); assert.equal(result.jobs[0].snippet, rows[0].snippet);
      assert.equal(result.settledTelemetry.total, 2); assert.equal(result.settledTelemetry.levels.L1, 1); assert.equal(result.settledTelemetry.levels.L5, 1);
      assert.equal(store.saves.length, 0);
      const cancelled = await partitionOfficialPostingRows(rows, { store, now, signal: AbortSignal.abort() });
      assert.equal(cancelled.unresolvedIndices.length, rows.length); assert.equal(cancelled.settledTelemetry.total, 0);
    },
  },
  {
    name: 'R3 service skips all twenty-one handoffs for 250 definitive cached misses and chunks only thirty unresolved input rows',
    async run() {
      const rows = Array.from({ length: 250 }, (_, index) => job(index));
      const store = memoryStore(rows.map(row => [row.sourceJobKey, record(row, posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] }))]));
      const result = await resolveOfficialPostings(rows, { store, fetch: noNetwork, callRaw: () => { throw new Error('250 settled rows must dispatch zero handoffs'); } });
      assert.equal(result.jobs.length, 250); assert.equal(result.telemetry.handoffs, 0); assert.equal(result.telemetry.levels.L5, 250);
      assert.equal(store.saves.length, 0);
      const normalized = result.jobs; const fresh = Array.from({ length: 30 }, (_, index) => job(index + 250));
      const partition = await partitionOfficialPostingRows([...normalized, ...fresh], { store });
      assert.deepEqual(partition.unresolvedIndices, Array.from({ length: 30 }, (_, index) => index + 250));
      const calls = [];
      const resolved = await resolveOfficialPostings(partition.unresolvedIndices.map(index => partition.jobs[index]), { store, fetch: noNetwork,
        resolve: async row => unresolvedOfficialPosting(row), callRaw: async (prompt, options) => { calls.push(options.hints); return response(prompt); } });
      assert.deepEqual(calls, [{ itemCount: 12, batch: 1, batchTotal: 3 }, { itemCount: 12, batch: 2, batchTotal: 3 }, { itemCount: 6, batch: 3, batchTotal: 3 }]);
      assert.equal(resolved.telemetry.handoffs, 3); assert.equal(mergeOfficialPostingTelemetry(partition.settledTelemetry, resolved.telemetry).total, 280);
    },
  },
  {
    name: 'R3 service runs six host rows in parallel with a shared fetch session and separate discovery budgets while research chunks remain sequential',
    async run() {
      const rows = Array.from({ length: 13 }, (_, index) => job(index)); const before = JSON.stringify(rows);
      const store = memoryStore(); const budgets = new Map(); const phases = { free: 0, pending: 0 }; const peak = { free: 0, pending: 0 };
      let freeCompleted = 0; let baseFetches = 0; const calls = []; const progress = [];
      const chunks = officialPostingChunks(rows);
      const result = await resolveOfficialPostings(rows, { store, onProgress: value => progress.push(value),
        fetch: async url => { baseFetches++; await delay(3); return { url, statusCode: 200, contentType: 'text/html', body: '<title>Shared root</title>' }; },
        resolve: async (row, options) => {
          const phase = options.bypassCache ? 'pending' : 'free'; phases[phase]++; peak[phase] = Math.max(peak[phase], phases[phase]);
          assert.equal(options.persistResults, false); assert.equal(options.persistMisses, false);
          assert.equal(options.signal, options.rowBudget.signal);
          if (budgets.has(row.sourceJobKey)) assert.notEqual(options.rowBudget, budgets.get(row.sourceJobKey)); else budgets.set(row.sourceJobKey, options.rowBudget);
          await options.fetch('https://shared.test/', { signal: options.signal }); await delay(Number(row.sourceJobKey.split('-')[1]) % 3 + 2);
          phases[phase]--;
          if (phase === 'free') { freeCompleted++; return unresolvedOfficialPosting(row); }
          return { officialPosting: posting({ title: row.title }) };
        }, callRaw: async (prompt, options) => {
          assert.equal(freeCompleted, rows.length, 'all free passes finish before the first handoff');
          assert.equal(phases.pending, 0, 'a later research chunk starts after earlier pending rows finish');
          calls.push({ prompt, hints: options.hints }); return response(prompt);
        } });
      assert.equal(JSON.stringify(rows), before); assert.deepEqual(peak, { free: 6, pending: 6 });
      assert.equal(baseFetches, 1); assert.equal(result.telemetry.fetches, 1); assert.equal(result.telemetry.uniqueUrls, 1); assert.equal(result.telemetry.cacheHits, 25);
      assert.equal(result.telemetry.maxPerHostRate, 1); assert.equal(result.telemetry.breakerTrips, 0);
      assert.equal(store.saves.length, 13, 'each verified row is written once by the service');
      assert.equal(result.jobs.every(row => row.officialPosting.level === 'L4'), true);
      assert.deepEqual(calls.map(call => call.hints), [{ itemCount: 12, batch: 1, batchTotal: 2 }, { itemCount: 1, batch: 2, batchTotal: 2 }]);
      for (let index = 0; index < calls.length; index++) for (const member of chunks[index]) assert.ok(calls[index].prompt.includes(member.id));
      assert.deepEqual(progress.at(-1), { completed: 13, total: 13 });
    },
  },
  {
    name: 'R3 service never stores stopped transient unavailable timed-out or malformed research misses and permits a healthy retry',
    async run() {
      const cases = ['stop', 'bridge-unavailable', 'bridge-timeout', 'parse-error', 'fetch-failed', 'fetch-timeout', 'failed', 'research-miss', 'bridge-aborted', 'crawl-budget'];
      for (const [index, code] of cases.entries()) {
        const row = job(index); const store = memoryStore(); const controller = new AbortController(); let calls = 0;
        const hostCode = ['fetch-failed', 'fetch-timeout', 'failed', 'research-miss', 'bridge-aborted', 'crawl-budget'].includes(code) ? code : null;
        const result = await resolveOfficialPostings([row], { store, fetch: noNetwork, signal: controller.signal,
          timeoutMs: code === 'bridge-timeout' ? 5 : undefined, bridgeAvailable: code !== 'bridge-unavailable',
          resolve: async value => unresolvedOfficialPosting(value, { outcome: hostCode === 'failed' ? 'failed' : 'not-found', trail: hostCode ? [hostCode] : [] }),
          callRaw: async prompt => { calls++;
            if (code === 'stop') { controller.abort(); throw new Error('stopped'); }
            if (code === 'bridge-timeout') { await delay(20); return response(prompt); }
            return code === 'parse-error' ? 'malformed' : response(prompt);
          } });
        assert.equal(store.saves.length, 0, `${code} must not create a durable miss`);
        assert.ok(['L5', 'L6'].includes(result.jobs[0].officialPosting.level));
        assert.equal(calls, code === 'bridge-unavailable' ? 0 : 1);
        let retried = 0;
        const healthy = await resolveOfficialPostings([row], { store, fetch: noNetwork,
          resolve: async value => unresolvedOfficialPosting(value, { trail: [OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] }),
          callRaw: async prompt => { retried++; return response(prompt); } });
        assert.equal(retried, 1, `${code} remains retryable on the next run`); assert.equal(store.saves.length, 1);
        assert.ok(healthy.jobs[0].officialPosting.trail.includes('bridge-research'));
      }
    },
  },
  {
    name: 'R3 legacy service retries old transient misses without persisting an unupgraded negative conclusion',
    async run() {
      const row = job(1, { snippet: `${description} The engineer reviews daily route records and explains delayed dispatch issues to experienced operational partners. Additional responsibilities include validating service changes and documenting useful release decisions with regional teams.` });
      const old = record(row, posting({ level: 'L5', outcome: 'not-found', trail: ['bridge-timeout'] }));
      const store = memoryStore([[row.sourceJobKey, old]]); let researched = 0; let fetched = 0;
      const result = await resolveOfficialPostings([row], { store, fetch: async () => { fetched++; const error = new Error('closed'); error.code = 'closed'; throw error; },
        callRaw: async prompt => { researched++; return response(prompt); } });
      assert.equal(researched, 1); assert.equal(fetched, 1, 'the shared negative cache prevents another host request in pass two');
      assert.equal(store.saves.length, 0); assert.equal(result.jobs[0].officialPosting.level, 'L5');
      assert.equal(result.jobs[0].officialPosting.trail.includes(OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL), false);
      assert.ok(result.jobs[0].officialPosting.trail.includes('bridge-research')); assert.equal(result.jobs[0].officialPosting.trail.includes('bridge-timeout'), false);
      assert.equal(result.jobs[0].officialPosting.trail.includes('recent-miss'), false);
    },
  },
  {
    name: 'R3 service persists clean parsed ambiguous results once and merges counts without leaking supplied facts or host names',
    async run() {
      const row = job(1); const store = memoryStore();
      const result = await resolveOfficialPostings([row], { store, fetch: noNetwork,
        resolve: async value => unresolvedOfficialPosting(value, { outcome: 'ambiguous', trail: ['ambiguous', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL], alternatives: [
          { title: 'Dispatch Engineer', url: 'https://northwind.test/jobs/alternative-one' },
          { title: 'Dispatch Engineer', url: 'https://northwind.test/jobs/alternative-two' },
        ] }),
        callRaw: async prompt => response(prompt) });
      assert.equal(store.saves.length, 1); assert.equal(result.jobs[0].officialPosting.outcome, 'ambiguous');
      const combined = mergeOfficialPostingTelemetry(result.telemetry, { total: 2, levels: { L1: 2, secret: 99 }, outcomes: { found: 2 },
        fetches: 8, uniqueUrls: 5, cacheHits: 3, maxPerHostRate: 4, breakerTrips: 1, rejections: { 'title-mismatch': 2, 'northwind.test': 999 }, snippet: 'private page content' },
      { fetches: 2, uniqueUrls: 1, cacheHits: 1, maxPerHostRate: 3, breakerTrips: 0, levels: { L1: 'unsafe count' } });
      assert.equal(combined.total, 3); assert.equal(combined.levels.L1, 2); assert.equal(combined.levels.L5, 1);
      assert.equal(combined.fetches, 10); assert.equal(combined.uniqueUrls, 6); assert.equal(combined.cacheHits, 4); assert.equal(combined.maxPerHostRate, 4); assert.equal(combined.breakerTrips, 1);
      assert.equal(combined.rejections['title-mismatch'], 2); assert.equal(/northwind|private|secret|unsafe/u.test(JSON.stringify(combined)), false);
    },
  },
  {
    name: 'R3 service stores a verified match when only the row host budget ended after it was found and drops it when the run stopped',
    async run() {
      const text = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
      const url = 'https://northwind.test/jobs/1'; const apply = ['https://northwind.test/apply/1', 'https://northwind.test/apply/2'];
      const lead = { title: 'Engineer 1', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada', snippet: text, source: 'google', url,
        sourceJobKey: 'source-budget', salaryProvenance: 'unknown', applyOptions: [url, ...apply].map(href => ({ label: 'Apply', href })) };
      const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>', [url]: `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting', title: 'Engineer 1', hiringOrganization: { name: 'Northwind Labs' }, description: text,
        jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } } })}</script>`,
      [apply[0]]: '<main>Apply</main>', [apply[1]]: '<main>Apply</main>' };
      const serve = (target, onRead) => { onRead?.(target); if (!pages[target]) throw Object.assign(new Error('closed'), { code: 'closed' });
        return { url: target, sourceUrl: target, statusCode: 200, contentType: 'text/html', body: pages[target] }; };
      const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
      try {
        // A slow employer host spends the row's sixty seconds of host time while its own leads are still being read.
        const store = memoryStore();
        const result = await resolveOfficialPostings([lead], { store, bridgeAvailable: false, fetch: async target => serve(target, read => { if (read === url) skew += 61_000; }) });
        assert.equal(result.jobs[0].officialPosting.level, 'L1'); assert.ok(result.jobs[0].officialPosting.trail.includes('fetch-timeout'));
        assert.equal(store.saves.length, 1, 'the verified record is stored so Generate and scoring can serve its text');
        assert.equal(store.saves[0].payload.description, text);
        skew = 0;
        const controller = new AbortController(); const stopped = memoryStore();
        const halted = await resolveOfficialPostings([lead], { store: stopped, bridgeAvailable: false, signal: controller.signal,
          fetch: async target => serve(target, read => { if (read === apply[0]) controller.abort(); }) });
        assert.equal(halted.jobs[0].officialPosting.level, 'L1');
        assert.equal(stopped.saves.length, 0, 'a stopped run never writes a result');
      } finally { Date.now = realNow; }
    },
  },
  {
    name: 'Amendment 4 service keeps partial text-only crawl matches for the current run without making them durable',
    async run() {
      const text = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
      const first = 'https://northwind.test/jobs/one'; const twin = 'https://northwind.test/jobs/two';
      const page = (url, body) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Software Engineer', url,
        hiringOrganization: { name: 'Northwind Labs' }, description: body, jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } } })}</script>`;
      const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>', [first]: page(first, text), [twin]: page(twin, `${text} Extra duties include travelling monthly.`) };
      const row = job('partial', { title: 'Software Engineer', snippet: text });
      const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
      try {
        const store = memoryStore();
        const result = await resolveOfficialPostings([row], { store, bridgeAvailable: false,
          resolve: (value, options) => resolveOfficialPosting(value, { ...options, candidateUrls: [first, twin] }),
          fetch: async url => { if (url === first) skew += 61_000; if (!pages[url]) throw Object.assign(new Error('closed'), { code: 'closed' });
            return { url, sourceUrl: url, statusCode: 200, contentType: 'text/html', body: pages[url] }; } });
        assert.equal(result.jobs[0].officialPosting.level, 'L1', 'the run retains its partial match');
        assert.ok(result.jobs[0].officialPosting.trail.includes('fetch-timeout'));
        assert.ok(result.jobs[0].officialPosting.trail.includes('description-anchor'));
        assert.equal(store.saves.length, 0, 'an unread sibling makes this text-only match non-durable');
      } finally { Date.now = realNow; }
    },
  },
  {
    name: 'Amendment 4 material change resave survives only a row budget timeout under the same safe durability policy',
    async run() {
      const text = 'Requirements include experience building reliable services and maintaining reporting workflows. Engineers design clear interfaces for dispatch teams and validate operational changes with careful review. The role includes improving data quality across scheduled pipelines and documenting decisions for partner teams. You will work with colleagues to investigate delivery failures and make service behavior understandable. Responsibilities include writing tests for new features and improving the tools used by support teams every day.';
      const url = 'https://northwind.test/jobs/one';
      const row = job('material', { title: 'Software Engineer', url, snippet: 'Short scraped summary about dispatch services.' });
      const pages = { 'https://northwind.test/': '<title>Northwind Labs</title>', [url]: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: row.title,
        hiringOrganization: { name: 'Northwind Labs' }, description: text, jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } } })}</script>` };
      const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
      try {
        const store = memoryStore();
        const result = await resolveOfficialPostings([row], { store, bridgeAvailable: false,
          fetch: async target => { if (target === url) skew += 61_000; if (!pages[target]) throw Object.assign(new Error('closed'), { code: 'closed' });
            return { url: target, sourceUrl: target, statusCode: 200, contentType: 'text/html', body: pages[target] }; } });
        assert.equal(result.jobs[0].officialPosting.level, 'L1');
        assert.ok(result.jobs[0].officialPosting.trail.includes('identifier-anchor'));
        assert.ok(result.jobs[0].officialPosting.trail.includes('material-jd-change'));
        assert.ok(store.saves.at(-1).payload.officialPosting.trail.includes('material-jd-change'), 'the durable metadata needs the same material-change signal');
      } finally { Date.now = realNow; }
    },
  },
  {
    name: 'R3 service releases its own run and row abort listeners while preserving an injected reusable fetch session',
    async run() {
      const controller = new AbortController(); const rows = Array.from({ length: 13 }, (_, index) => job(index));
      const options = { signal: controller.signal, store: memoryStore(), fetch: noNetwork,
        resolve: async value => unresolvedOfficialPosting(value), callRaw: async prompt => response(prompt) };
      await resolveOfficialPostings(rows, options);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'owned row budgets and session release their run listeners');
      let disposed = false;
      const fetchSession = { fetch: noNetwork, telemetry: () => ({ fetches: 0, uniqueUrls: 0, cacheHits: 0, maxPerHostRate: 0, breakerTrips: 0 }),
        dispose: () => { disposed = true; } };
      await resolveOfficialPostings(rows, { ...options, fetchSession });
      assert.equal(disposed, false, 'a caller can reuse its own shared session across service invocations');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
  },
  {
    name: 'Amendment 5 service integrates comparative agreement correction prompt replay and counts-only accepted telemetry',
    async run() {
      const fixture = comparativeServiceFixture([{ id: 'one' }, { id: 'two', quotes: COMPARATIVE_SIBLING }, { id: 'city-twin', city: 'Riverton' }]);
      const row = comparisonRow(); const store = memoryStore(); const calls = []; let researched = 0;
      const result = await resolveOfficialPostings([row], { store, fetchSession: fixture.fetchSession,
        callRaw: async (...args) => { researched++; return fixture.research(...args); },
        callMatch: async (prompt, options) => {
          const visible = comparisonVisible(prompt); const run = options.hints.comparisonRun;
          assert.equal(visible.options.length, 2); assert.equal(prompt.includes('Riverton'), false);
          calls.push({ prompt, options });
          assert.match(options.manualHandoff.comparisonGroup, /^[a-f0-9]{64}$/u);
          assert.equal(options.manualHandoff.comparisonRun, run);
          const answer = serviceComparisonAnswer(visible);
          if (run === 'A' && !options.correctionAttempt) answer.evidence[0].officialQuote = 'A fabricated quotation about unrelated lunar navigation and international satellite support.';
          if (options.correctionAttempt) {
            assert.ok(options.correctionRuleIds.includes('LOOKUP_OFFICIAL_MATCH_VERBATIM'));
            assert.ok(options.correctionDetails.every(line => line.length <= 260));
          }
          return JSON.stringify(answer);
        } });
      assert.equal(result.jobs[0].officialPosting.sourceUrl, fixture.candidateUrls[0]);
      assert.equal(result.jobs[0].officialPosting.level, 'L1');
      assert.deepEqual(calls.map(call => [call.options.hints.comparisonRun, call.options.correctionAttempt || 0]), [['A', 0], ['A', 1], ['B', 0]]);
      assert.equal(calls[0].prompt, calls[1].prompt);
      assert.equal(calls[0].options.manualHandoff.comparisonGroup, calls[2].options.manualHandoff.comparisonGroup);
      assert.deepEqual(comparisonVisible(calls[0].prompt).options.map(option => option.id), ['P1', 'P2']);
      assert.deepEqual(comparisonVisible(calls[2].prompt).options.map(option => option.id), ['P2', 'P1']);
      assert.equal(calls[2].options.correctionDetails, undefined);
      assert.equal(researched, 1); assert.equal(result.telemetry.handoffs, 4);
      assert.equal(result.telemetry.comparisons, 1); assert.equal(result.telemetry.comparisonOptions[2], 1);
      assert.equal(result.telemetry.comparativeAgreements, 1); assert.equal(result.telemetry.comparativeMatches, 1);
      assert.equal(result.telemetry.comparativeInvalidRuns, 0); assert.equal(result.telemetry.rejections['comparative-match'], undefined);
      assert.equal(/Northwind|freight|Quote|description/u.test(JSON.stringify(result.telemetry)), false);
      let replayed = 0;
      const again = await resolveOfficialPostings([row], { store, fetchSession: fixture.fetchSession,
        callRaw: async () => { replayed++; throw new Error('A cached proof must not create another handoff'); },
        callMatch: async () => { replayed++; throw new Error('A cached proof must not create another comparison'); } });
      assert.equal(replayed, 0); assert.equal(again.telemetry.comparisons, 0); assert.equal(again.telemetry.comparativeMatches, 1);
      assert.equal(again.jobs[0].officialPosting.sourceUrl, fixture.candidateUrls[0]);
      assert.ok(again.jobs[0].officialPosting.trail.includes('comparative-choice-p1'));
    },
  },
  {
    name: 'Amendment 5 legacy none and disagreement preserve bounded decisions but retry without current discovery proof',
    async run() {
      for (const kind of ['none', 'disagree']) {
        const fixture = comparativeServiceFixture([{ id: 'one' }, { id: 'two', quotes: COMPARATIVE_SIBLING }]);
        const row = comparisonRow(); const store = memoryStore();
        const callMatch = async (prompt, options) => JSON.stringify(serviceComparisonAnswer(comparisonVisible(prompt),
          kind === 'none' ? 'none' : options.hints.comparisonRun === 'A' ? 'P1' : 'P2'));
        const result = await resolveOfficialPostings([row], { store, fetchSession: fixture.fetchSession, callRaw: fixture.research, callMatch });
        assert.equal(result.jobs[0].officialPosting.outcome, kind === 'none' ? 'not-found' : 'ambiguous');
        assert.equal(store.saves.length, 0); assert.equal(result.telemetry.comparisons, 1);
        assert.equal(result.jobs[0].officialPosting.trail.includes(OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL), false);
        assert.equal(result.telemetry.comparativeAgreements, kind === 'none' ? 1 : 0);
        assert.equal(result.telemetry.comparativeDisagreements, kind === 'disagree' ? 1 : 0);
        assert.equal(result.telemetry.comparativeNone, kind === 'none' ? 1 : 0);
        assert.equal(result.telemetry.comparativeInvalidRuns, 0); assert.equal(result.telemetry.comparativeMatches, 0);
        if (kind === 'disagree') assert.equal(result.jobs[0].officialPosting.alternatives.length, 2);
        assert.equal(/Quote|description|distinguishing/u.test(JSON.stringify(result.jobs[0].officialPosting)), false);
        let calls = 0;
        const replay = await resolveOfficialPostings([row], { store, fetchSession: fixture.fetchSession,
          callRaw: async (...args) => { calls++; return fixture.research(...args); }, callMatch });
        assert.equal(calls, 1); assert.equal(replay.jobs[0].officialPosting.trail.includes('recent-miss'), false);
        assert.equal(store.saves.length, 0);
      }
    },
  },
  {
    name: 'Amendment 5 service timeout and independence-unavailable remain retryable with accurate comparative counts',
    async run() {
      for (const code of ['bridge-timeout', 'OFFICIAL_POSTING_COMPARATIVE_UNAVAILABLE']) {
        const fixture = comparativeServiceFixture([{ id: 'one' }]); const store = memoryStore(); let calls = 0;
        const keepAlive = setTimeout(() => {}, 500); let result;
        try {
          result = await resolveOfficialPostings([comparisonRow()], { store, fetchSession: fixture.fetchSession,
            callRaw: fixture.research, timeoutMs: 10,
            callMatch: async (prompt, options) => {
              calls++;
              if (options.hints.comparisonRun === 'B') {
                if (code === 'bridge-timeout') return new Promise(() => {});
                throw Object.assign(new Error(code), { code });
              }
              return JSON.stringify(serviceComparisonAnswer(comparisonVisible(prompt)));
            } });
        } finally { clearTimeout(keepAlive); }
        assert.equal(calls, 2); assert.equal(store.saves.length, 0); assert.equal(result.jobs[0].officialPosting.outcome, 'not-found');
        assert.ok(result.jobs[0].officialPosting.trail.includes(code === 'bridge-timeout' ? code : 'comparative-unavailable'));
        assert.equal(result.telemetry.comparisons, 1); assert.equal(result.telemetry.comparativeInvalidRuns, 1);
        assert.equal(result.telemetry.comparativeAgreements, 0); assert.equal(result.telemetry.comparativeMatches, 0);
        assert.equal(result.telemetry.comparativeUnavailable, code === 'OFFICIAL_POSTING_COMPARATIVE_UNAVAILABLE' ? 1 : 0);
        assert.equal(result.telemetry.bridgeTimeout, code === 'bridge-timeout' ? 1 : 0);
        const healthy = await resolveOfficialPostings([comparisonRow()], { store, fetchSession: fixture.fetchSession,
          callRaw: fixture.research, callMatch: async prompt => JSON.stringify(serviceComparisonAnswer(comparisonVisible(prompt))) });
        assert.equal(healthy.jobs[0].officialPosting.level, 'L1');
      }
    },
  },
  {
    name: 'Amendment 5 service corrects injected invalid raw answers once per run without double retries',
    async run() {
      const fixture = comparativeServiceFixture([{ id: 'one' }]); const store = memoryStore(); const calls = [];
      const result = await resolveOfficialPostings([comparisonRow()], { store, fetchSession: fixture.fetchSession, callRaw: fixture.research,
        callMatch: async (prompt, options) => { calls.push({ prompt, options }); return JSON.stringify({ choice: 'unknown', evidence: [], distinguishing: [], conflicts: [] }); } });
      assert.deepEqual(calls.map(call => [call.options.hints.comparisonRun, call.options.correctionAttempt || 0]), [['A', 0], ['A', 1], ['B', 0], ['B', 1]]);
      assert.equal(calls[0].prompt, calls[1].prompt); assert.equal(calls[2].prompt, calls[3].prompt);
      assert.equal(result.telemetry.comparativeInvalidRuns, 2); assert.equal(store.saves.length, 0);
      assert.ok(result.jobs[0].officialPosting.trail.includes('comparative-invalid'));
    },
  },
];
