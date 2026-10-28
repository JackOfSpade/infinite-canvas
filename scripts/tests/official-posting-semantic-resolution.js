import assert from 'node:assert/strict';
import { resolveOfficialPosting, shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import { resolveSemanticOfficialPosting } from '../../electron/ipc/officialPostingSemanticResolution.js';
import { officialPostingSemanticInputHash, officialPostingSemanticProofMatches } from '../../electron/ipc/officialPostingSemantic.js';
import { officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';

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
          assert.equal(rejected.officialPosting.outcome, 'not-found');
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
