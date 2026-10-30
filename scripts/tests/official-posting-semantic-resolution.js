import assert from 'node:assert/strict';
import { createOfficialPostingRowBudget, resolveOfficialPosting, shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import { resolveSemanticOfficialPosting } from '../../electron/ipc/officialPostingSemanticResolution.js';
import { officialPostingSemanticInputHash, officialPostingSemanticProofMatches } from '../../electron/ipc/officialPostingSemantic.js';
import { officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';
import { _resetOfficialPostingDiscoveryDiagnosticsForTests, getOfficialPostingDiscoveryDiagnosticsSnapshot } from '../../electron/ipc/officialPostingDiscoveryDiagnostics.js';

const SCRAPED = 'Create delivery planning tools for regional operations teams. Talk with distribution coordinators to learn what slows their work. Turn their findings into dependable systems and improve the way schedules are prepared.';
const OFFICIAL = 'Engineers improve route allocation services used by depot supervisors. Interview operational partners about freight handoffs, then design software that makes dispatch decisions easier. Maintain reliable release procedures while refining the product around customer feedback.';
const row = (extra = {}) => ({ title: 'Delivery Platform Developer', company: 'Northwind Labs',
  location: 'Lakeview, Ontario, Canada', snippet: SCRAPED, url: 'https://www.linkedin.com/jobs/view/synthetic-semantic-17', ...extra });
const html = (body, url) => ({ body, url, sourceUrl: url, contentType: 'text/html', statusCode: 200 });
const posting = (url, extra = {}) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting',
  title: 'Dispatch Systems Engineer', hiringOrganization: { name: 'Northwind Labs' }, identifier: 'dispatch-17',
  description: OFFICIAL, url,
  jobLocation: { address: { addressLocality: 'Harbor', addressRegion: 'Washington', addressCountry: 'United States' } },
  ...extra })}</script>`;
function fixture(extra = {}) {
  const url = 'https://northwind.test/jobs/dispatch-17';
  const pages = { 'https://northwind.test/': '<meta property="og:site_name" content="Northwind Labs">',
    [url]: posting(url, extra) };
  const requests = [];
  const fetch = async target => {
    requests.push(target);
    // The root names no careers page, so its conventional path is read; this site has none (404), which is not a failed read.
    if (target === 'https://northwind.test/careers' && !(target in pages)) throw Object.assign(new Error('Not found'), { code: 'closed' });
    if (!(target in pages)) throw Object.assign(new Error('Synthetic page not retained'), { code: 'fetch-failed' });
    return typeof pages[target] === 'string' ? html(pages[target], target) : pages[target];
  };
  return { url, pages, requests, fetch };
}
function memoryStore() {
  const saved = [];
  return { saved, find: async () => null, save: async (_job, record) => {
    const result = { ...record, id: String(saved.length + 1) }; saved.push(result); return result;
  } };
}
function choose(option) {
  return { choice: option.id, evidence: [{ scrapedQuote: SCRAPED, officialQuote: option.description }],
    distinguishing: [], conflicts: [] };
}
const noMatch = reason => ({ choice: 'none', evidence: [], distinguishing: [], conflicts: [reason] });
const uncertain = reason => ({ choice: 'uncertain', evidence: [], distinguishing: [], conflicts: [reason] });

export default [
  {
    name: 'Discovery finality keeps empty research incomplete and preserves a completed two-comparison miss',
    async run() {
      _resetOfficialPostingDiscoveryDiagnosticsForTests();
      try {
        const job = row();
        for (const code of ['fetch-failed', 'fetch-timeout']) {
          const result = await resolveOfficialPosting(job, { semanticMatching: true, researchRan: true,
            candidateUrls: ['https://northwind.test/careers'], persistResults: false, render: null,
            fetch: async () => { throw Object.assign(new Error('Synthetic denied read'), { code, statusCode: 403 }); } });
          const diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
          assert.equal(diagnostic.candidateCount, 0); assert.equal(diagnostic.eligibleCount, 0);
          assert.equal(diagnostic.comparisonRuns, 0); assert.equal(diagnostic.semanticSettled, false);
          assert.equal(diagnostic.stage, 'final'); assert.equal(diagnostic.settled, false);
          assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        }
        const f = fixture(); f.pages['https://northwind.test/careers'] = '<h1>Careers</h1><p>There are no open roles to display.</p>';
        for (const code of ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ENOENT']) {
          const partial = await resolveOfficialPosting(job, { semanticMatching: true, researchRan: true,
            candidateUrls: ['https://northwind.test/careers'], persistResults: false, fetch: f.fetch,
            render: async () => { throw Object.assign(new Error('PRIVATE_MODULE_PATH'), { code }); } });
          assert.ok(partial.officialPosting.trail.includes('crawl-partial'));
          const diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
          assert.equal(diagnostic.settled, false);
          assert.equal(diagnostic.renderStats.attempts, 1); assert.equal(diagnostic.renderStats.successes, 0);
          assert.equal(diagnostic.renderStats.cacheReuses, 0);
          assert.equal(diagnostic.renderStats.failures['renderer-unavailable'], 1);
          assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_MODULE_PATH'), false);
        }
        const result = await resolveOfficialPosting(job, { semanticMatching: true, researchRan: true,
          candidateUrls: ['https://northwind.test/careers'], persistResults: false, render: null, fetch: f.fetch });
        let diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
        assert.equal(diagnostic.candidateCount, 0); assert.equal(diagnostic.semanticSettled, false);
        assert.equal(diagnostic.stage, 'final'); assert.equal(diagnostic.settled, false);
        assert.ok(result.officialPosting.trail.includes('research-miss'));
        assert.equal(result.officialPosting.semanticMatch, undefined);
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false);
        const compared = await resolveOfficialPosting(job, { semanticMatching: true, researchRan: true,
          candidateUrls: [f.url], fetch: f.fetch, match: async () => noMatch('The complete official posting describes a different role.') });
        diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
        assert.equal(diagnostic.candidateCount, 1); assert.equal(diagnostic.comparisonRuns, 2);
        assert.equal(diagnostic.semanticSettled, true); assert.equal(diagnostic.settled, true);
        assert.equal(shouldPersistOfficialPostingResult(compared, { researchRan: true }), true);
      } finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
    },
  },
  {
    name: 'Discovery rendering counts distinguish completed rendering from shared rendered cache reuse',
    async run() {
      _resetOfficialPostingDiscoveryDiagnosticsForTests();
      let previous;
      try {
        const f = fixture(); f.pages['https://northwind.test/careers'] = '<main>Current openings load using JavaScript.</main>';
        for (const phase of ['initial', 'cached']) {
          const budget = createOfficialPostingRowBudget({ previous });
          await resolveOfficialPosting(row(), { semanticMatching: true, researchRan: true, rowBudget: budget,
            candidateUrls: ['https://northwind.test/careers'], fetch: f.fetch,
            render: async url => ({ url, contentType: 'text/html', body: '<main>No current openings.</main>' }) });
          const stats = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0].renderStats;
          assert.equal(stats.attempts, phase === 'initial' ? 1 : 0);
          assert.equal(stats.successes, phase === 'initial' ? 1 : 0);
          assert.equal(stats.cacheReuses > 0, phase === 'cached');
          assert.ok(Object.values(stats.failures).every(value => value === 0));
          budget.dispose(); previous = budget;
        }
      } finally { previous?.dispose(); _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
    },
  },
  {
    name: 'Discovery keeps verified identity finality, marks save failures incomplete and leaves cached attempt counts untouched',
    async run() {
      _resetOfficialPostingDiscoveryDiagnosticsForTests();
      try {
        const f = fixture(); const job = row();
        const result = await resolveOfficialPosting(job, { semanticMatching: true,
          candidateUrls: [f.url, 'https://northwind.test/jobs/synthetic-unavailable'], fetch: f.fetch,
          match: async (_job, options) => choose(options[0]) });
        let diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
        assert.equal(result.officialPosting.outcome, 'found'); assert.equal(diagnostic.outcome, 'found');
        assert.equal(diagnostic.stage, 'final'); assert.equal(diagnostic.settled, true);
        assert.equal(diagnostic.semanticSettled, true); assert.equal(diagnostic.comparisonRuns, 2);
        const beforeCache = getOfficialPostingDiscoveryDiagnosticsSnapshot();
        const cached = await resolveOfficialPosting(job, { semanticMatching: true,
          store: { find: async () => ({ aliases: officialPostingAliases(job), officialPosting: result.officialPosting }) },
          fetch: async () => { throw new Error('A cache hit must not fetch'); } });
        assert.ok(cached.officialPosting.trail.includes('cache-hit'));
        assert.deepEqual(getOfficialPostingDiscoveryDiagnosticsSnapshot(), beforeCache);
        const failed = await resolveOfficialPosting(job, { semanticMatching: true,
          candidateUrls: [f.url], fetch: f.fetch, match: async (_job, options) => choose(options[0]),
          store: { find: async () => null, save: async () => { throw new Error('Synthetic storage failure'); } } });
        diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
        assert.equal(failed.officialPosting.outcome, 'failed'); assert.equal(diagnostic.outcome, 'failed');
        assert.equal(diagnostic.stage, 'final'); assert.equal(diagnostic.settled, false);
        assert.equal(diagnostic.semanticSettled, true); assert.equal(diagnostic.comparisonRuns, 2);
        const controller = new AbortController();
        await resolveOfficialPosting(job, { semanticMatching: true, signal: controller.signal,
          candidateUrls: [f.url], fetch: f.fetch, match: async (_job, options) => choose(options[0]),
          store: { find: async () => null, save: async (_job, record) => { controller.abort(); return record; } } });
        diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
        assert.equal(diagnostic.semanticSettled, true); assert.equal(diagnostic.settled, false,
          'cancellation during an awaited save is reflected in finality');
        const direct = await resolveSemanticOfficialPosting(job, []);
        diagnostic = getOfficialPostingDiscoveryDiagnosticsSnapshot().observations[0];
        assert.equal(direct.settled, false, 'empty candidate inventory cannot establish absence');
        assert.equal(diagnostic.semanticSettled, false); assert.equal(diagnostic.settled, null);
        assert.equal(diagnostic.stage, 'semantic', 'direct comparison has no final crawl or persistence outcome');
      } finally { _resetOfficialPostingDiscoveryDiagnosticsForTests(); }
    },
  },
  {
    name: 'fetched postings without employer ownership proof cannot establish a settled semantic miss',
    async run() {
      const candidate = { sourceUrl: 'https://jobs.ashbyhq.com/northwind-synthetic/dispatch-17',
        employer: 'Northwind Labs', title: 'Dispatch Systems Engineer', description: OFFICIAL };
      let calls = 0;
      const result = await resolveSemanticOfficialPosting(row(), [candidate], {
        match: async () => { calls++; return noMatch('No comparison may admit an unproved source.'); },
      });
      assert.equal(calls, 0); assert.equal(result.settled, false);
      assert.ok(result.trail.includes('source-unproven'));
      const empty = await resolveSemanticOfficialPosting(row(), []);
      assert.equal(empty.outcome, 'ambiguous'); assert.equal(empty.settled, false);
      assert.ok(empty.trail.includes('research-miss'));
      const mixed = await resolveSemanticOfficialPosting(row(), [candidate,
        { ...candidate, sourceUrl: 'https://northwind.test/jobs/dispatch-17', employerDomainProven: true }], {
        match: async (_job, options) => { calls++; assert.equal(options.length, 1); return choose(options[0]); },
      });
      assert.equal(calls, 2); assert.equal(mixed.outcome, 'found'); assert.equal(mixed.settled, true);
      const partialNegative = await resolveSemanticOfficialPosting(row(), [candidate,
        { ...candidate, sourceUrl: 'https://northwind.test/jobs/other-role', employerDomainProven: true }], {
        match: async () => noMatch('The eligible source describes a different role; the unproved source was not compared.'),
      });
      assert.equal(partialNegative.settled, false, 'comparison covers only the eligible subset');
      assert.ok(partialNegative.trail.includes('comparative-none'));
      assert.ok(partialNegative.trail.includes('source-unproven'));
    },
  },
  {
    name: 'fresh shared resolution retains a bound historical identity when its exact official URL now returns 404 or 410',
    async run() {
      for (const statusCode of [404, 410]) {
        const f = fixture(); const job = row();
        const first = await resolveOfficialPosting(job, { fetch: f.fetch, candidateUrls: [f.url],
          semanticMatching: true, match: async (_job, options) => choose(options[0]) });
        const priorOfficialRecord = { aliases: officialPostingAliases(job), officialPosting: first.officialPosting };
        let calls = 0;
        const result = await resolveOfficialPosting(job, { priorOfficialRecord, bypassCache: true, semanticMatching: true, persistResults: false,
          store: { readText: async () => OFFICIAL }, fetch: async () => { throw Object.assign(new Error('Gone'), { code: 'closed', statusCode }); },
          match: async (_job, options) => { calls++; assert.ok(options.every(option => option.status === 'closed')); return choose(options[0]); } });
        assert.equal(result.officialPosting.outcome, 'closed');
        assert.ok(result.officialPosting.trail.includes('closed'));
        assert.equal(calls, 2);
        assert.equal(result.description, undefined);
        for (const changed of [{ ...priorOfficialRecord, aliases: [] },
          { ...priorOfficialRecord, officialPosting: { ...first.officialPosting, semanticMatch: { ...first.officialPosting.semanticMatch, inputHash: 'f'.repeat(64) } } },
          { ...priorOfficialRecord, officialPosting: { ...first.officialPosting, semanticMatch: { ...first.officialPosting.semanticMatch, sourceHash: undefined } } }]) {
          const rejected = await resolveOfficialPosting(job, { priorOfficialRecord: changed, semanticMatching: true, bypassCache: true,
            candidateUrls: [f.url], fetch: async () => { throw Object.assign(new Error('Gone'), { code: 'closed', statusCode }); },
            match: async () => { throw new Error('No historical identity should be admitted'); } });
          assert.equal(rejected.officialPosting.outcome, 'ambiguous');
          assert.ok(rejected.officialPosting.trail.includes('research-miss'));
          assert.equal(shouldPersistOfficialPostingResult(rejected, { researchRan: true }), false);
        }
      }
    },
  },
  {
    name: 'minimal verified ATS receipts infer their tenant from the source URL and stale API active cannot override its fresh HTTP closure',
    async run() {
      const job = row({ title: 'Software Engineer' });
      const url = 'https://jobs.smartrecruiters.com/Northwind/740000000000019-software-engineer';
      const api = 'https://api.smartrecruiters.com/v1/companies/Northwind/postings/740000000000019';
      const priorOfficialRecord = { aliases: officialPostingAliases(job), officialPosting: {
        level: 'L2', outcome: 'found', employer: job.company, title: job.title, sourceUrl: url,
        trail: ['semantic-match-v1'], semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(job), sourceHash: 'a'.repeat(64) },
      } };
      let calls = 0;
      const result = await resolveOfficialPosting(job, { priorOfficialRecord, bypassCache: true, semanticMatching: true,
        candidateUrls: ['https://northwind.test/careers'], fetch: async value => {
          if (value === url) throw Object.assign(new Error('Gone'), { code: 'closed', statusCode: 404 });
          if (value === api) return { url: value, contentType: 'application/json', statusCode: 200, body: JSON.stringify({
            id: '740000000000019', name: job.title, active: true, postingUrl: url,
            company: { identifier: 'Northwind', name: job.company },
            jobAd: { sections: { jobDescription: { title: 'Responsibilities', text: OFFICIAL } } },
          }) };
          return html(`<title>Northwind Labs</title><a href="${url}">Current opportunity</a>`, value);
        }, match: async (_job, options) => {
          calls++; assert.ok(options.length > 0); assert.ok(options.every(option => option.status === 'closed'));
          return { choice: options[0].id, evidence: [{ scrapedQuote: job.title, officialQuote: job.title }], distinguishing: [], conflicts: [] };
        } });
      assert.equal(calls, 2);
      assert.equal(result.officialPosting.outcome, 'closed');
    },
  },
  {
    name: 'a new exact open official source can replace a now-closed previously verified URL',
    async run() {
      const f = fixture(); const job = row();
      const first = await resolveOfficialPosting(job, { fetch: f.fetch, candidateUrls: [f.url], semanticMatching: true,
        match: async (_job, options) => choose(options[0]) });
      const replacement = 'https://northwind.test/jobs/dispatch-replacement';
      f.pages[replacement] = posting(replacement);
      const result = await resolveOfficialPosting(job, { bypassCache: true, semanticMatching: true, persistResults: false,
        priorOfficialRecord: { aliases: officialPostingAliases(job), officialPosting: first.officialPosting },
        candidateUrls: [replacement], store: { readText: async () => OFFICIAL },
        fetch: async url => { if (url === f.url) throw Object.assign(new Error('Gone'), { code: 'closed', statusCode: 410 }); return f.fetch(url); },
        match: async (_job, options) => { assert.ok(options.some(option => option.status === 'closed'));
          return choose(options.find(option => option.sourceUrl === replacement)); } });
      assert.equal(result.officialPosting.outcome, 'found');
      assert.equal(result.officialPosting.sourceUrl, replacement);
    },
  },
  {
    name: 'a known prior closure never labels a distinct unavailable identity as the closed source',
    async run() {
      const f = fixture(); const job = row();
      const first = await resolveOfficialPosting(job, { fetch: f.fetch, candidateUrls: [f.url], semanticMatching: true,
        match: async (_job, options) => choose(options[0]) });
      const other = 'https://northwind.test/jobs/unavailable-other';
      f.pages[other] = posting(other, { validThrough: '2000-01-01' });
      const result = await resolveOfficialPosting(job, { bypassCache: true, semanticMatching: true, persistResults: false,
        priorOfficialRecord: { aliases: officialPostingAliases(job), officialPosting: first.officialPosting },
        candidateUrls: [other], store: { readText: async () => OFFICIAL },
        fetch: async url => { if (url === f.url) throw Object.assign(new Error('Gone'), { code: 'closed', statusCode: 410 }); return f.fetch(url); },
        match: async (_job, options) => choose(options.find(option => option.sourceUrl === other)) });
      assert.equal(result.officialPosting.outcome, 'closed');
      assert.equal(result.officialPosting.sourceUrl, f.url);
      assert.notEqual(result.officialPosting.sourceUrl, other);
    },
  },
  {
    name: 'fresh host visible closure uses the shared liveness callback and uncertain closure never becomes live',
    async run() {
      for (const verdict of ['closed', 'unclear', 'open']) {
        const f = fixture(); const job = row();
        f.pages[f.url] += '<h1>Dispatch Systems Engineer</h1><nav>Northwind Labs official careers. Explore current opportunities and learn about the engineering team.</nav><div>This job is no longer available.</div>';
        let livenessCalls = 0;
        const result = await resolveOfficialPosting(job, { fetch: f.fetch, candidateUrls: [f.url], semanticMatching: true,
          checkLiveness: async (_job, evidence) => { livenessCalls++; assert.ok(evidence.closedHits.some(hit => !hit.insideDescription)); return verdict; },
          match: async (_job, options) => choose(options[0]) });
        assert.equal(livenessCalls, 1);
        assert.equal(result.officialPosting.outcome, verdict === 'open' ? 'found' : verdict === 'closed' ? 'closed' : 'unreadable');
        if (verdict === 'unclear') assert.ok(result.officialPosting.trail.includes('official-liveness-unconfirmed'));
      }
    },
  },
  {
    name: 'a partial crawl keeps an independently agreed semantic identity durable without an identifier anchor',
    run() {
      const trail = ['crawl-partial', 'semantic-match-v1', 'comparative-match', 'comparative-a-valid',
        'comparative-b-valid', 'comparative-a-p1', 'comparative-b-p1', 'comparative-choice-p1'];
      const posting = { level: 'L1', outcome: 'found', employer: 'Northwind Labs', trail,
        semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(row()), sourceHash: 'd'.repeat(64) } };
      assert.equal(shouldPersistOfficialPostingResult(posting), true);
      assert.equal(shouldPersistOfficialPostingResult(posting, { signal: { aborted: true } }), false);
      for (const missing of ['comparative-a-valid', 'comparative-b-valid', 'comparative-match', 'comparative-b-p1']) {
        assert.equal(shouldPersistOfficialPostingResult({ ...posting, trail: trail.filter(code => code !== missing) }), false, missing);
      }
      assert.equal(shouldPersistOfficialPostingResult({ ...posting, semanticMatch: { version: 1, inputHash: posting.semanticMatch.inputHash } }), false);
      assert.equal(shouldPersistOfficialPostingResult({ level: 'L5', outcome: 'not-found', employer: 'Northwind Labs',
        trail: ['crawl-partial', 'semantic-match-v1', 'comparative-none'] }, { researchRan: true }), false);
    },
  },
  {
    name: 'Semantic equivalent representations of one live posting settle on a deterministic representative; every other split stays unsettled',
    async run() {
      const src = (extra = {}) => ({ employerDomainProven: true, employer: 'Northwind Labs', title: 'Dispatch Systems Engineer',
        description: OFFICIAL, location: { display: 'Lakeview, Canada' }, sourceUrl: 'https://northwind.test/jobs/dispatch-17', ...extra });
      const split = async (candidates, pick) => {
        const seen = [];
        const result = await resolveSemanticOfficialPosting(row(), candidates, { match: async (_job, options, { run }) => {
          seen.push(options); return pick(options, run); } });
        return { result, options: seen[0] };
      };
      const aThenB = (a, b) => (options, run) => { const wanted = run === 'A' ? a : b; return wanted === 'none' ? noMatch('Not this one.') : choose(options.find(item => item.id === wanted)); };
      // Same canonical URL, conflicting representations: the proven, fuller one wins whichever run picked it.
      const sameUrl = [src({ tenantProven: true, description: `${OFFICIAL} Extra duties.` }), src({ description: OFFICIAL, location: { display: 'Harbor, United States' } })];
      for (const [a, b] of [['P1', 'P2'], ['P2', 'P1']]) {
        const { result, options } = await split(sameUrl, aThenB(a, b));
        const rep = options.find(item => item.candidate.tenantProven === true).id.toLowerCase();
        assert.equal(result.outcome, 'found'); assert.equal(result.settled, true);
        assert.deepEqual(result.trail.slice(-3), ['comparative-equivalent', `comparative-choice-${rep}`, 'comparative-match']);
        assert.ok(result.trail.includes('comparative-a-valid') && result.trail.includes('comparative-b-valid'));
        assert.equal(result.trail.includes('comparative-disagree'), false);
        assert.equal(result.candidate.tenantProven, true);
        assert.equal(result.comparison.disagreement, false);
        assert.equal(result.comparison.accepted, true);
      }
      // Equal proof and length: the lower option id represents the posting.
      const tie = await split([src({ identifier: 'a' }), src({ identifier: 'b' })], aThenB('P2', 'P1'));
      assert.equal(tie.result.outcome, 'found'); assert.ok(tie.result.trail.includes('comparative-choice-p1'));
      // Different URLs of one requisition (identifier bound in the URL).
      const req = await split([src({ identifier: 'REQ-445566', sourceUrl: 'https://northwind.test/jobs/REQ-445566' }),
        src({ identifier: 'REQ-445566', sourceUrl: 'https://northwind.test/careers/opening?id=REQ-445566' })], aThenB('P1', 'P2'));
      assert.equal(req.result.outcome, 'found'); assert.ok(req.result.trail.includes('comparative-equivalent'));
      // Negatives: nothing is manufactured.
      const urlB = 'https://northwind.test/jobs/dispatch-18';
      const negatives = {
        'different titles': [[src(), src({ title: 'Dispatch Systems Architect' })], ['P1', 'P2']],
        'different requisitions': [[src({ identifier: 'REQ-111111', sourceUrl: 'https://northwind.test/jobs/REQ-111111' }),
          src({ identifier: 'REQ-222222', sourceUrl: urlB })], ['P1', 'P2']],
        'one closed one live': [[src(), src({ isListed: false })], ['P1', 'P2']],
        'different employers': [[src(), src({ employer: 'Southwind Labs' })], ['P1', 'P2']],
        'A none B option': [[src(), src({ description: `${OFFICIAL} More.` })], ['none', 'P1']],
        'A option B none': [[src(), src({ description: `${OFFICIAL} More.` })], ['P2', 'none']],
      };
      for (const [name, [candidates, [a, b]]] of Object.entries(negatives)) {
        const { result } = await split(candidates, aThenB(a, b));
        assert.equal(result.outcome, 'ambiguous', name); assert.equal(result.settled, false, name);
        assert.equal(result.trail.includes('comparative-equivalent'), false, name);
        assert.equal(result.trail.includes('comparative-match'), false, name);
        assert.equal(result.comparison.disagreement, true, name);
      }
      const unsure = await split(sameUrl, (options, run) => run === 'A' ? choose(options[0]) : uncertain('Cannot tell.'));
      assert.equal(unsure.result.outcome, 'ambiguous'); assert.equal(unsure.result.trail.includes('comparative-equivalent'), false);
    },
  },
  {
    name: 'a partial crawl keeps an equivalent split durable only for the exact representative shape',
    run() {
      const base = ['crawl-partial', 'semantic-match-v1', 'comparative-a-valid', 'comparative-b-valid', 'comparative-a-p1', 'comparative-b-p2',
        'comparative-equivalent', 'comparative-choice-p1', 'comparative-match'];
      const posting = { level: 'L1', outcome: 'found', employer: 'Northwind Labs', trail: base,
        semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(row()), sourceHash: 'e'.repeat(64) } };
      assert.equal(shouldPersistOfficialPostingResult(posting), true);
      assert.equal(shouldPersistOfficialPostingResult({ ...posting, trail: base.map(code => code === 'comparative-choice-p1' ? 'comparative-choice-p2' : code) }), true);
      // Without the equivalence code a split is not an agreement.
      assert.equal(shouldPersistOfficialPostingResult({ ...posting, trail: base.filter(code => code !== 'comparative-equivalent') }), false);
      // The representative must be one run's choice, and the other run must have a real option.
      assert.equal(shouldPersistOfficialPostingResult({ ...posting, trail: base.map(code => code === 'comparative-choice-p1' ? 'comparative-choice-p3' : code) }), false);
      assert.equal(shouldPersistOfficialPostingResult({ ...posting, trail: base.map(code => code === 'comparative-b-p2' ? 'comparative-b-none' : code) }), false);
      assert.equal(shouldPersistOfficialPostingResult({ ...posting, trail: base.filter(code => code !== 'comparative-match') }), false);
      assert.equal(shouldPersistOfficialPostingResult({ ...posting, trail: base.filter(code => code !== 'comparative-b-valid') }), false);
      // A plain non-equivalent split never persists under a partial crawl.
      assert.equal(shouldPersistOfficialPostingResult({ ...posting, trail: ['crawl-partial', 'semantic-match-v1', 'comparative-a-valid',
        'comparative-b-valid', 'comparative-a-p1', 'comparative-b-p2', 'comparative-disagree'] }), false);
    },
  },
  {
    name: 'Semantic resolver accepts an AI-confirmed paraphrase despite different title location work mode and posted pay',
    async run() {
      const f = fixture({ jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { name: 'United States' },
        baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { value: 99000, unitText: 'YEAR' } } });
      const input = row({ salary: 'CAD 125000/yr', salaryProvenance: 'posted' });
      const store = memoryStore(); const calls = [];
      const result = await resolveOfficialPosting(input, { fetch: f.fetch, candidateUrls: [f.url],
        semanticMatching: true, store, match: async (_job, options, { run }) => {
          calls.push({ run, options }); return choose(options[0]);
        } });
      assert.deepEqual(calls.map(call => call.run), ['A', 'B']);
      assert.equal(result.officialPosting.outcome, 'found');
      assert.equal(result.officialPosting.sourceUrl, f.url);
      assert.equal(result.description, OFFICIAL);
      assert.ok(result.officialPosting.trail.includes('comparative-match'));
      assert.equal(officialPostingSemanticProofMatches(input, result.officialPosting), true);
      assert.equal(store.saved.length, 1);
    },
  },
  {
    name: 'Semantic resolver preserves a host-proven legal employer name containing a hyphen when the poster is an intermediary',
    async run() {
      const f = fixture({ hiringOrganization: { name: 'Atlas-Orbit Labs' } });
      f.pages['https://northwind.test/'] = '<meta property="og:site_name" content="Atlas-Orbit Labs">';
      const input = row({ company: 'Northwind Talent' });
      const result = await resolveOfficialPosting(input, { fetch: f.fetch, candidateUrls: [f.url], semanticMatching: true,
        match: async (_job, options) => choose(options[0]) });
      assert.equal(result.officialPosting.outcome, 'found');
      assert.equal(result.officialPosting.employer, 'Atlas-Orbit Labs');
      assert.equal(result.postedBy, 'Northwind Talent');
      assert.equal(officialPostingSemanticProofMatches(input, result.officialPosting), true);
    },
  },
  {
    name: 'Semantic resolver retains short AI-confirmed official text instead of imposing a word-count or role-keyword identity gate',
    async run() {
      const f = fixture({ description: 'Own dispatch tooling.' });
      const result = await resolveOfficialPosting(row(), { fetch: f.fetch, candidateUrls: [f.url],
        semanticMatching: true, match: async (_job, options) => choose(options[0]) });
      assert.equal(result.officialPosting.outcome, 'found');
      assert.equal(result.description, 'Own dispatch tooling.');
    },
  },
  {
    name: 'Semantic resolver requires two judgments even for a same-title source and persists an agreed wrong-sibling none separately',
    async run() {
      const f = fixture(); const store = memoryStore(); const calls = [];
      const result = await resolveOfficialPosting(row(), { fetch: f.fetch, candidateUrls: [f.url], semanticMatching: true,
        store, match: async (_job, _options, { run }) => { calls.push(run); return noMatch('This source describes a different operational team.'); } });
      assert.deepEqual(calls, ['A', 'B']);
      assert.equal(result.officialPosting.outcome, 'not-found');
      assert.ok(result.officialPosting.trail.includes('comparative-none'));
      assert.equal(officialPostingSemanticProofMatches(row(), result.officialPosting), true);
      assert.equal(store.saved.length, 1);
    },
  },
  {
    name: 'Semantic A B disagreement uncertainty and unavailable comparisons remain unsettled and nondurable',
    async run() {
      for (const kind of ['disagree', 'uncertain', 'invalid', 'unavailable']) {
        const f = fixture(); const store = memoryStore();
        const result = await resolveOfficialPosting(row(), { fetch: f.fetch, candidateUrls: [f.url], semanticMatching: true,
          store, match: kind === 'unavailable' ? undefined : async (_job, options, { run }) => {
            if (kind === 'uncertain') return uncertain('These sources do not establish the same requisition.');
            if (run === 'A') return choose(options[0]);
            if (kind === 'disagree') return noMatch('This may be a related sibling role.');
            return { ...choose(options[0]), evidence: [{ scrapedQuote: SCRAPED, officialQuote: 'Invented official quote.' }] };
          } });
        assert.equal(result.officialPosting.outcome, 'ambiguous', kind);
        assert.equal(officialPostingSemanticProofMatches(row(), result.officialPosting), false, kind);
        assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), false, kind);
        assert.equal(store.saved.length, 0, kind);
      }
    },
  },
  {
    name: 'Semantic resolver preserves conflicting HTML and API representations of one Ashby URL for AI comparison',
    async run() {
      const career = 'https://northwind.test/careers';
      const target = 'https://jobs.ashbyhq.com/northwind/dispatch-17';
      const api = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
      const pages = {
        'https://northwind.test/': html('<meta property="og:site_name" content="Northwind Labs">', 'https://northwind.test/'),
        [career]: html(`<a href="${target}">Dispatch opening</a>`, career),
        [target]: html(posting(target, { jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { name: 'United States' } }), target),
        [api]: { body: JSON.stringify({ jobs: [{ id: 'dispatch-17', title: 'Dispatch Systems Engineer',
          location: 'Harbor, Washington, United States', workplaceType: 'Hybrid', isRemote: true, isListed: true,
          jobUrl: target, applyUrl: `${target}/application`, descriptionPlain: OFFICIAL }] }),
        url: api, contentType: 'application/json', statusCode: 200 },
      };
      const seen = [];
      const result = await resolveOfficialPosting(row(), { candidateUrls: [career], semanticMatching: true,
        fetch: async url => {
          if (!pages[url]) throw Object.assign(new Error('Synthetic page not retained'), { code: 'fetch-failed' });
          return pages[url];
        }, match: async (_job, options, { run }) => {
          seen.push({ run, options });
          assert.equal(options.length, 2);
          assert.equal(new Set(options.map(option => option.sourceUrl)).size, 1);
          assert.deepEqual(new Set(options.map(option => option.workMode)), new Set(['remote', 'hybrid']));
          return choose(options.find(option => option.workMode === 'hybrid'));
        } });
      assert.equal(seen.length, 2);
      assert.equal(result.officialPosting.outcome, 'found');
      assert.equal(result.officialPosting.location.workMode, 'hybrid');
      assert.equal(result.officialPosting.location.remote, false);
    },
  },
  {
    name: 'Semantic shortlist covers every source across multiple chunks and performs another round for an oversized union',
    async run() {
      const candidates = Array.from({ length: 130 }, (_, index) => ({ employerDomainProven: true,
        sourceUrl: `https://northwind.test/jobs/dispatch-${index}`, employer: 'Northwind Labs', title: `Engineer ${index}`,
        description: OFFICIAL, location: { display: 'Lakeview, Canada' }, identifier: String(index) }));
      const rounds = []; const final = [];
      const result = await resolveSemanticOfficialPosting(row(), candidates, {
        shortlist: async (_job, chunk) => {
          rounds.push(chunk.map(item => item.id));
          return { selected: chunk.slice(0, rounds.length <= 3 ? 8 : 2).map(item => item.id), uncertain: false };
        },
        match: async (_job, options, { run }) => { final.push({ run, options }); return choose(options[0]); },
      });
      assert.deepEqual(rounds.map(items => items.length), [64, 64, 2, 18]);
      assert.equal(new Set(rounds.slice(0, 3).flat()).size, 130, 'every candidate is presented before any reduction');
      assert.deepEqual(final.map(call => call.run), ['A', 'B']);
      assert.equal(final[0].options.length, 2);
      assert.equal(result.outcome, 'found');
      assert.equal(result.comparison.preCapCount, 130);
    },
  },
  {
    name: 'Semantic shortlist uncertainty and source availability uncertainty cannot create a confirmed closed result',
    async run() {
      const candidates = Array.from({ length: 9 }, (_, index) => ({ employerDomainProven: true,
        sourceUrl: `https://northwind.test/jobs/dispatch-${index}`, title: `Engineer ${index}`, description: OFFICIAL }));
      let matched = false;
      const triage = await resolveSemanticOfficialPosting(row(), candidates, { shortlist: async () => ({ selected: ['C1'], uncertain: true }),
        match: async () => { matched = true; return noMatch('Not called'); } });
      assert.equal(triage.settled, false);
      assert.equal(matched, false);
      const unavailable = await resolveSemanticOfficialPosting(row(), [{ ...candidates[0], live: false }], {
        match: async (_job, options) => choose(options[0]),
      });
      assert.equal(unavailable.outcome, 'unreadable');
      assert.equal(unavailable.settled, false);
      assert.ok(unavailable.trail.includes('official-liveness-unconfirmed'));
    },
  },
];
