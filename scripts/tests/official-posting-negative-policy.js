import assert from 'node:assert/strict';
import {
  OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL,
  officialPostingNegativeNeedsRecheck,
} from '../../electron/ipc/officialPostingNegativePolicy.js';
import { officialPostingDisplay, officialPostingNeedsRefresh } from '../../src/utils/officialPostingDisplay.js';
import { officialPostingSemanticInputHash } from '../../electron/ipc/officialPostingSemantic.js';
import { officialPostingAliases } from '../../electron/ipc/officialPostingStore.js';
import { partitionOfficialPostingRows } from '../../electron/ipc/officialPostingService.js';
import { resolveOfficialPosting, shouldPersistOfficialPostingResult } from '../../electron/ipc/officialPostingResolver.js';
import { officialPostingLookupStatus } from '../../electron/ipc/officialPostingFields.js';

const proof = { version: 1, inputHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64) };
const posting = (extra = {}) => ({ level: 'L5', outcome: 'not-found', employer: 'Synthetic Employer',
  trail: ['bridge-research', 'semantic-match-v1', 'comparative-none'], semanticMatch: { ...proof }, ...extra });

export default [
  {
    name: 'Legacy ownership-discovery misses require a new check without changing positive or closed facts',
    run() {
      for (const level of ['L5', 'L6']) {
        for (const outcome of ['not-found', 'ambiguous']) {
          const previous = posting({ level, outcome });
          const before = structuredClone(previous);
          assert.equal(officialPostingNegativeNeedsRecheck(previous), true);
          for (const marker of ['ownership-discovery-v2', 'ownership-discovery-v3']) {
            const legacy = { ...previous, trail: [...previous.trail, marker] };
            assert.equal(officialPostingNegativeNeedsRecheck(legacy), true, 'legacy discovery could incorrectly settle an empty or capped inventory');
            assert.equal(officialPostingLookupStatus(legacy).retryable, true);
            assert.equal(shouldPersistOfficialPostingResult(legacy, { researchRan: true }), false);
            assert.notEqual(officialPostingDisplay({ officialPosting: legacy }).statusLabel, 'No exact official posting found');
          }
          assert.equal(officialPostingNegativeNeedsRecheck({ ...previous,
            trail: [...previous.trail, OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] }), false);
          assert.deepEqual(previous, before, 'migration is a read policy, never an edit to saved lookup facts');
        }
      }
      for (const level of ['L1', 'L2', 'L3', 'L4']) {
        for (const outcome of ['found', 'link-only', 'closed']) {
          assert.equal(officialPostingNegativeNeedsRecheck(posting({ level, outcome })), false);
        }
      }
      for (const value of [null, undefined, [], {}, posting({ outcome: 'closed' }),
        posting({ outcome: 'unreadable' }), posting({ outcome: 'failed' })]) {
        assert.equal(officialPostingNegativeNeedsRecheck(value), false);
      }
    },
  },
  {
    name: 'Ownership-discovery upgrade bypasses recent legacy negative cache despite a matching input proof',
    async run() {
      const source = { title: 'Synthetic role', company: 'Synthetic Employer', location: 'Synthetic City',
        url: 'https://listing.example.test/cached-synthetic', snippet: 'Synthetic original source description.' };
      const prior = posting({ semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(source) } });
      const savedAt = Date.now();
      for (const marker of ['', 'ownership-discovery-v2', 'ownership-discovery-v3', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL]) {
        const current = marker === OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL;
        const officialPosting = { ...prior,
          trail: [...prior.trail, ...(marker ? [marker] : [])] };
        const record = { version: 1, aliases: officialPostingAliases(source), savedAt, officialPosting };
        const result = await partitionOfficialPostingRows([{ ...source, officialPosting }], {
          store: { find: async () => record }, now: () => savedAt,
        });
        assert.deepEqual(result.unresolvedIndices, current ? [] : [0]);
      }
    },
  },
  {
    name: 'Current ownership-discovery negative remains durable after two eligible posting comparisons both return none',
    async run() {
      const root = 'https://northwind.test/'; const first = `${root}jobs/first`; const second = `${root}jobs/second`;
      const description = 'Design reliable services and investigate delivery failures for dispatch teams. Maintain reporting workflows, improve data quality across scheduled pipelines, and document operational changes. Collaborate with product engineers to build clear interfaces, write focused tests, and improve the everyday tools used by customer support teams.';
      const source = { title: 'Software Engineer', company: 'Northwind Labs', location: 'Lakeview, Ontario, Canada',
        url: 'https://www.linkedin.com/jobs/view/synthetic-current-negative', snippet: description };
      const page = title => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title,
        hiringOrganization: { name: source.company }, description,
        jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } } })}</script>`;
      const pages = { [root]: '<title>Northwind Labs</title><a href="/careers">Careers</a>',
        [`${root}careers`]: `<a href="${first}">First role</a><a href="${second}">Second role</a>`,
        [first]: page('Reporting Engineer'), [second]: page('Support Engineer') };
      let comparisons = 0;
      const result = await resolveOfficialPosting(source, { semanticMatching: true, researchRan: true,
        candidateUrls: [root, first, second], render: null,
        fetch: async url => {
          if (!pages[url]) throw Object.assign(new Error('Unavailable'), { code: 'closed' });
          return { url, statusCode: 200, contentType: 'text/html', body: pages[url] };
        },
        match: async (_job, options) => {
          comparisons++; assert.equal(options.length, 2, 'both employer-owned candidates are eligible');
          return { choice: 'none', evidence: [], distinguishing: [], conflicts: ['Both postings describe different teams.'] };
        },
      });
      assert.equal(comparisons, 2);
      assert.equal(result.officialPosting.outcome, 'not-found');
      assert.ok(result.officialPosting.trail.includes('comparative-none'));
      assert.ok(result.officialPosting.trail.includes(OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL));
      assert.equal(shouldPersistOfficialPostingResult(result, { researchRan: true }), true);
      assert.equal(officialPostingLookupStatus(result.officialPosting).state, 'not-found');
      const savedAt = Date.now();
      const record = { version: 1, aliases: officialPostingAliases(source), savedAt, officialPosting: result.officialPosting };
      const cached = await partitionOfficialPostingRows([{ ...source, officialPosting: result.officialPosting }], {
        store: { find: async () => record }, now: () => savedAt,
      });
      assert.deepEqual(cached.unresolvedIndices, [], 'a genuine current negative comparison can be reused');
    },
  },
  {
    name: 'Saved semantic no-match cards become refreshable after ownership-discovery upgrade',
    run() {
      const job = { title: 'Synthetic role', company: 'Synthetic Employer', location: 'Synthetic City',
        url: 'https://listing.example.test/synthetic', officialPosting: posting(),
        notes: 'Synthetic retained note', matchScore: 83, localApplication: { id: 'synthetic-saved-application' } };
      const before = structuredClone(job);
      assert.equal(officialPostingNeedsRefresh(job), true);
      const oldDisplay = officialPostingDisplay(job);
      assert.equal(oldDisplay.lookupRetryable, true);
      assert.equal(oldDisplay.lookupNeedsRefresh, true);
      assert.notEqual(oldDisplay.statusLabel, 'No exact official posting found');
      const current = { ...job, officialPosting: { ...job.officialPosting,
        trail: [...job.officialPosting.trail, OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] } };
      assert.equal(officialPostingNeedsRefresh(current), false);
      assert.equal(officialPostingDisplay(current).statusLabel, 'No exact official posting found');
      const verified = { ...job, officialPosting: posting({ level: 'L1', outcome: 'found',
        sourceUrl: 'https://employer.example.test/jobs/synthetic', trail: ['semantic-match-v1'] }) };
      assert.equal(officialPostingNeedsRefresh(verified), false);
      assert.equal(officialPostingDisplay(verified).statusLabel, 'Exact official posting verified');
      assert.deepEqual(job, before);
    },
  },
];
