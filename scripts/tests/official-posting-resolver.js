import assert from 'node:assert/strict';
import { officialPostingAdapterUrl, officialPostingChunks, officialPostingRequestId, shouldPersistOfficialPostingResult, unresolvedOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';

const row = (extra = {}) => ({ title: 'Software Engineer at Northwind Labs', company: 'Acme Talent Partners', location: 'Lakeview, Ontario, Canada',
  snippet: 'Our client is hiring.', url: 'https://www.linkedin.com/jobs/view/synthetic-1', salaryProvenance: 'unknown', ...extra });

export default [
  {
    name: 'Official posting sorted twelve-row chunks are deterministic before cache state is consulted',
    run() {
      const jobs = Array.from({ length: 25 }, (_, i) => row({ url: `https://board.test/${i}`, title: `Engineer ${i}` }));
      const chunks = officialPostingChunks(jobs); const reversed = officialPostingChunks([...jobs].reverse());
      assert.deepEqual(chunks, reversed); assert.deepEqual(chunks.map(chunk => chunk.length), [12, 12, 1]);
      assert.equal(officialPostingRequestId(jobs[0]), officialPostingRequestId({ ...jobs[0], officialPosting: { level: 'L2' } }));
    },
  },
  {
    name: 'Official posting adapter URLs bind a Greenhouse detail id only to its own tenant and use the board API otherwise',
    run() {
      const greenhouse = { ats: 'greenhouse', tenant: 'northwind' };
      assert.equal(officialPostingAdapterUrl(greenhouse, 'https://boards.greenhouse.io/northwind/jobs/12345'),
        'https://boards-api.greenhouse.io/v1/boards/northwind/jobs/12345?questions=false');
      assert.equal(officialPostingAdapterUrl(greenhouse, 'https://boards.greenhouse.io/other/jobs/12345'),
        'https://boards-api.greenhouse.io/v1/boards/northwind/jobs?content=true');
      assert.equal(officialPostingAdapterUrl({ ats: 'ashby', tenant: 'northwind' }, 'https://jobs.ashbyhq.com/northwind/req-one'),
        'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true');
      assert.equal(officialPostingAdapterUrl({ ats: 'lever', tenant: 'northwind' }, 'https://jobs.lever.co/northwind/one'),
        'https://api.lever.co/v0/postings/northwind?mode=json');
    },
  },
  {
    name: 'Official posting unresolved fallback keeps the scraped identity out of the resolution and never throws on an invalid row',
    run() {
      const missing = unresolvedOfficialPosting(row(), { outcome: 'ambiguous', trail: ['worker-research', 'research-miss'] });
      assert.equal(missing.officialPosting.outcome, 'ambiguous');
      assert.deepEqual(missing.officialPosting.trail, ['worker-research', 'research-miss']);
      assert.equal(unresolvedOfficialPosting(null).officialPosting.outcome !== undefined, true);
    },
  },
  {
    name: 'Official posting durability keeps retryable transient misses out of the store and settled misses in it',
    run() {
      const miss = (trail, extra = {}) => ({ level: 'L5', outcome: 'not-found', employer: 'Acme Talent Partners', trail: [...trail, OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL], ...extra });
      for (const code of ['worker-aborted', 'worker-timeout', 'worker-unavailable', 'research-miss', 'fetch-failed', 'fetch-timeout', 'failed', 'semantic-uncertain']) {
        assert.equal(shouldPersistOfficialPostingResult(miss([code]), { researchRan: true }), false, code);
      }
      assert.equal(shouldPersistOfficialPostingResult(miss(['comparative-none'])), true);
      assert.equal(shouldPersistOfficialPostingResult(miss(['worker-research'])), true);
      assert.equal(shouldPersistOfficialPostingResult(miss([])), false);
      assert.equal(shouldPersistOfficialPostingResult({ ...miss(['comparative-none']), trail: ['comparative-none'] }), false, 'a negative without the current ownership-proof marker is rechecked');
      assert.equal(shouldPersistOfficialPostingResult(miss(['comparative-none']), { signal: { aborted: true } }), false);
      assert.equal(shouldPersistOfficialPostingResult(miss(['comparative-none'], { fetchFailures: [{ url: 'https://northwind.test/jobs/1', code: 'fetch-failed' }] })), false);
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
];
